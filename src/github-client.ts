import { errAsync, ResultAsync } from 'neverthrow'

import type { OctoStsTokenCache } from '#auth/octo-sts'
import { BoundaryError } from '#errors'

export class GitHubApiError extends BoundaryError {}

export interface PullRequestSummary {
  number: number
  title: string
  url: string
}

export interface FailedStep {
  job: string
  step: string
}

export interface GitHubClient {
  findPullRequestForCommit(
    owner: string,
    repo: string,
    sha: string,
  ): ResultAsync<PullRequestSummary | null, GitHubApiError>
  findFailedStep(
    owner: string,
    repo: string,
    runId: number,
  ): ResultAsync<FailedStep | null, GitHubApiError>
}

const GITHUB_API_BASE = 'https://api.github.com'

interface PullRequestResponseItem {
  number: number
  title: string
  html_url: string
}

interface JobsResponse {
  jobs: Array<{
    name: string
    steps: Array<{ name: string; conclusion: string | null }>
  }>
}

export const createGitHubClient = (
  tokenCache: OctoStsTokenCache,
): GitHubClient => {
  const request = <T>(path: string): ResultAsync<T, GitHubApiError> =>
    tokenCache
      .getToken()
      .mapErr(
        (cause) =>
          new GitHubApiError('failed to obtain a GitHub API token', cause),
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

  return {
    findPullRequestForCommit: (owner, repo, sha) =>
      request<PullRequestResponseItem[]>(
        `/repos/${owner}/${repo}/commits/${sha}/pulls`,
      ).map((prs) => {
        const pr = prs[0]
        return pr === undefined
          ? null
          : { number: pr.number, title: pr.title, url: pr.html_url }
      }),
    findFailedStep: (owner, repo, runId) =>
      // ponytail: reads only the first 100 jobs (API max per_page), so a run
      // with a larger matrix can miss its failed step. Add Link-header
      // pagination if that turns out to matter in practice.
      request<JobsResponse>(
        `/repos/${owner}/${repo}/actions/runs/${String(runId)}/jobs?per_page=100`,
      ).map(({ jobs }) => {
        for (const job of jobs) {
          const step = job.steps.find((s) => s.conclusion === 'failure')
          if (step !== undefined) return { job: job.name, step: step.name }
        }
        return null
      }),
  }
}
