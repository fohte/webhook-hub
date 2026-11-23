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
  { type: 'superseded' } | { type: 'cancelled'; step: FailedStep | null }

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

const CONCURRENCY_CANCELLATION_MESSAGE_PREFIX =
  'Canceling since a higher priority waiting request'

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
  ): ResultAsync<boolean, GitHubApiError> => {
    const job = jobs[index]
    if (job === undefined) return okAsync(false)

    return request<CheckRunAnnotation[]>(
      `/repos/${owner}/${repo}/check-runs/${String(job.id)}/annotations?per_page=100`,
    ).andThen((annotations) =>
      annotations.some(({ message }) =>
        message.startsWith(CONCURRENCY_CANCELLATION_MESSAGE_PREFIX),
      )
        ? okAsync(true)
        : findConcurrencyCancellation(owner, repo, jobs, index + 1),
    )
  }

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
      request<JobsResponse>(
        `/repos/${owner}/${repo}/actions/runs/${String(runId)}/jobs?per_page=100`,
      ).andThen(({ jobs }) => {
        if (jobs.length === 0)
          return okAsync<CancelledWorkflowRun>({ type: 'superseded' })

        return findConcurrencyCancellation(owner, repo, jobs).map(
          (superseded): CancelledWorkflowRun => {
            if (superseded) return { type: 'superseded' }

            const cancelledStep =
              jobs.flatMap((job) =>
                job.steps
                  .filter((step) => step.conclusion === 'cancelled')
                  .map((step) => ({ job: job.name, step: step.name })),
              )[0] ?? null

            return {
              type: 'cancelled',
              step: cancelledStep,
            }
          },
        )
      }),
  }
}
