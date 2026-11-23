import type { OctoStsTokenCache } from '@fohte/service-kit/octo-sts'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import { BoundaryError } from '#errors'

export class GitHubApiError extends BoundaryError {}

// Distinguishes a token acquisition failure from every other GitHubApiError
// cause, so callers can tell a persistent auth outage apart from a
// transient GitHub API failure without depending on octo-sts's error type.
export class GitHubAuthError extends GitHubApiError {}

export interface PullRequestSummary {
  number: number
  title: string
  url: string
}

export interface FailedStep {
  job: string
  step: string
}

export type CancelledWorkflowRun =
  | {
      type: 'superseded'
      annotationLookupError: GitHubApiError | null
    }
  | {
      type: 'cancelled'
      step: FailedStep | null
      annotationLookupError: GitHubApiError | null
    }

export interface GitHubClient {
  findPullRequestForCommit(
    owner: string,
    repo: string,
    sha: string,
    headBranch?: string,
  ): ResultAsync<PullRequestSummary | null, GitHubApiError>
  findFailedStep(
    owner: string,
    repo: string,
    runId: number,
  ): ResultAsync<FailedStep | null, GitHubApiError>
  findCancelledWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): ResultAsync<CancelledWorkflowRun, GitHubApiError>
}

const GITHUB_API_BASE = 'https://api.github.com'

interface PullRequestResponseItem {
  number: number
  title: string
  html_url: string
  head: { ref: string }
}

interface JobsResponse {
  jobs: Array<{
    id: number
    name: string
    steps: Array<{ name: string; conclusion: string | null }>
  }>
}

interface CheckRunAnnotation {
  message: string
}

type AnnotationLookupResult =
  | { annotations: CheckRunAnnotation[]; error: null }
  | { annotations: null; error: GitHubApiError }

interface ConcurrencyCancellationLookup {
  superseded: boolean
  annotationLookupError: GitHubApiError | null
}

const CONCURRENCY_CANCELLATION_MESSAGE_PREFIX =
  'Canceling since a higher priority waiting request'
const JOBS_PAGE_SIZE = 100
const ANNOTATION_LOOKUP_BATCH_SIZE = 10

export const createGitHubClient = (
  tokenCache: OctoStsTokenCache,
): GitHubClient => {
  const request = <T>(path: string): ResultAsync<T, GitHubApiError> =>
    tokenCache
      .getToken()
      .mapErr(
        (cause) =>
          new GitHubAuthError('failed to obtain a GitHub API token', cause),
      )
      .andThen((token) =>
        ResultAsync.fromPromise(
          fetch(`${GITHUB_API_BASE}${path}`, {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
            },
          }),
          (cause) =>
            new GitHubApiError(`GitHub API request failed: ${path}`, cause),
        ),
      )
      .andThen((res) => {
        if (!res.ok) {
          return errAsync(
            new GitHubApiError(
              `GitHub API returned HTTP ${String(res.status)}: ${path}`,
              undefined,
            ),
          )
        }
        return ResultAsync.fromPromise(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- trusts GitHub's documented REST response shape without runtime validation
          res.json() as Promise<T>,
          (cause) =>
            new GitHubApiError(
              `GitHub API returned malformed JSON: ${path}`,
              cause,
            ),
        )
      })

  const findConcurrencyCancellation = (
    owner: string,
    repo: string,
    jobs: JobsResponse['jobs'],
    index = 0,
    previousError: GitHubApiError | null = null,
  ): ResultAsync<ConcurrencyCancellationLookup, never> => {
    const batch = jobs.slice(index, index + ANNOTATION_LOOKUP_BATCH_SIZE)
    if (batch.length === 0)
      return okAsync({
        superseded: false,
        annotationLookupError: previousError,
      })

    return ResultAsync.combine(
      batch.map(({ id }) =>
        request<CheckRunAnnotation[]>(
          `/repos/${owner}/${repo}/check-runs/${String(id)}/annotations?per_page=100`,
        )
          .map((annotations): AnnotationLookupResult => ({
            annotations,
            error: null,
          }))
          .orElse((error) =>
            okAsync<AnnotationLookupResult>({ annotations: null, error }),
          ),
      ),
    ).andThen((results) => {
      const annotationLookupError =
        previousError ??
        results.find(({ error }) => error !== null)?.error ??
        null
      const superseded = results.some(
        ({ annotations }) =>
          annotations !== null &&
          annotations.some(({ message }) =>
            message.startsWith(CONCURRENCY_CANCELLATION_MESSAGE_PREFIX),
          ),
      )
      return superseded
        ? okAsync({ superseded, annotationLookupError })
        : findConcurrencyCancellation(
            owner,
            repo,
            jobs,
            index + ANNOTATION_LOOKUP_BATCH_SIZE,
            annotationLookupError,
          )
    })
  }

  const findWorkflowRunJobs = (
    owner: string,
    repo: string,
    runId: number,
    page = 1,
    previousJobs: JobsResponse['jobs'] = [],
  ): ResultAsync<JobsResponse['jobs'], GitHubApiError> =>
    request<JobsResponse>(
      `/repos/${owner}/${repo}/actions/runs/${String(runId)}/jobs?per_page=${String(JOBS_PAGE_SIZE)}&page=${String(page)}`,
    ).andThen(({ jobs }) => {
      const allJobs = [...previousJobs, ...jobs]
      return jobs.length < JOBS_PAGE_SIZE
        ? okAsync(allJobs)
        : findWorkflowRunJobs(owner, repo, runId, page + 1, allJobs)
    })

  return {
    findPullRequestForCommit: (owner, repo, sha, headBranch) =>
      request<PullRequestResponseItem[]>(
        `/repos/${owner}/${repo}/commits/${sha}/pulls`,
      ).map((prs) => {
        const pr =
          headBranch === undefined
            ? prs[0]
            : prs.find(({ head }) => head.ref === headBranch)
        return pr === undefined
          ? null
          : { number: pr.number, title: pr.title, url: pr.html_url }
      }),
    findFailedStep: (owner, repo, runId) =>
      request<JobsResponse>(
        `/repos/${owner}/${repo}/actions/runs/${String(runId)}/jobs?per_page=100`,
      ).map(({ jobs }) => {
        for (const job of jobs) {
          const step = job.steps.find((s) => s.conclusion === 'failure')
          if (step !== undefined) return { job: job.name, step: step.name }
        }
        return null
      }),
    findCancelledWorkflowRun: (owner, repo, runId) =>
      findWorkflowRunJobs(owner, repo, runId).andThen((jobs) => {
        if (jobs.length === 0)
          return okAsync<CancelledWorkflowRun>({
            type: 'superseded',
            annotationLookupError: null,
          })

        return findConcurrencyCancellation(owner, repo, jobs).map(
          ({ superseded, annotationLookupError }): CancelledWorkflowRun => {
            if (superseded) return { type: 'superseded', annotationLookupError }

            const cancelledStep =
              jobs.flatMap((job) =>
                job.steps
                  .filter((step) => step.conclusion === 'cancelled')
                  .map((step) => ({ job: job.name, step: step.name })),
              )[0] ?? null

            return {
              type: 'cancelled',
              step: cancelledStep,
              annotationLookupError,
            }
          },
        )
      }),
  }
}
