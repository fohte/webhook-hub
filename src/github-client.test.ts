import type { OctoStsTokenCache } from '@fohte/service-kit/octo-sts'
import { OctoStsError } from '@fohte/service-kit/octo-sts'
import { errAsync, okAsync } from 'neverthrow'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createGitHubClient,
  GitHubApiError,
  GitHubAuthError,
} from '#github-client'

const createTokenCache = (
  overrides: {
    getToken?: ReturnType<OctoStsTokenCache['getToken']>
  } = {},
) => ({
  getToken: vi.fn().mockReturnValue(overrides.getToken ?? okAsync('ghs_token')),
})

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

const observeCancelledRun = (result: unknown, urls: string[]) => ({
  result,
  urls,
})

const observeCancellationPagination = (result: unknown, urls: string[]) => ({
  result,
  jobPages: urls.filter((url) => url.includes('/jobs?')),
  lateJobAnnotationCalls: urls.filter((url) =>
    url.includes('/check-runs/101/annotations'),
  ),
  annotationRequestCount: urls.filter((url) => url.includes('/check-runs/'))
    .length,
})

describe('createGitHubClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('findPullRequestForCommit', () => {
    it('returns the PR whose head branch matches the workflow run', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse([
            {
              number: 12,
              title: 'Update unrelated settings',
              html_url: 'https://github.com/fohte/example/pull/12',
              head: { ref: 'unrelated-branch' },
            },
            {
              number: 13,
              title: 'Refresh generated files',
              html_url: 'https://github.com/fohte/example/pull/13',
              head: { ref: 'generated-sync/topic' },
            },
          ]),
        ),
      )
      const client = createGitHubClient(createTokenCache())

      const result = await client.findPullRequestForCommit(
        'fohte',
        'example',
        'sha1',
        'generated-sync/topic',
      )

      expect(result._unsafeUnwrap()).toEqual({
        number: 13,
        title: 'Refresh generated files',
        url: 'https://github.com/fohte/example/pull/13',
      })
    })

    it('returns null when no associated PR has the workflow run branch', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse([
            {
              number: 12,
              title: 'Update unrelated settings',
              html_url: 'https://github.com/fohte/example/pull/12',
              head: { ref: 'unrelated-branch' },
            },
          ]),
        ),
      )
      const client = createGitHubClient(createTokenCache())

      const result = await client.findPullRequestForCommit(
        'fohte',
        'example',
        'sha1',
        'generated-sync/topic',
      )

      expect(result._unsafeUnwrap()).toBeNull()
    })

    it('returns the first PR summary for the commit', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse([
          {
            number: 128,
            title: 'Bump aws provider',
            html_url: 'https://github.com/fohte/example/pull/128',
          },
        ]),
      )
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findPullRequestForCommit(
        'fohte',
        'example',
        'sha1',
      )

      expect(result._unsafeUnwrap()).toEqual({
        number: 128,
        title: 'Bump aws provider',
        url: 'https://github.com/fohte/example/pull/128',
      })
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        'https://api.github.com/repos/fohte/example/commits/sha1/pulls',
        {
          headers: {
            authorization: 'Bearer ghs_token',
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
        },
      )
    })

    it('returns null when no PR is associated with the commit', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])))
      const client = createGitHubClient(createTokenCache())

      const result = await client.findPullRequestForCommit(
        'fohte',
        'example',
        'sha1',
      )

      expect(result._unsafeUnwrap()).toBeNull()
    })
  })

  describe('findFailedStep', () => {
    it('returns the first failed step across multiple jobs', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            jobs: [
              {
                name: 'lint',
                steps: [{ name: 'Run eslint', conclusion: 'success' }],
              },
              {
                name: 'plan (production)',
                steps: [
                  { name: 'checkout', conclusion: 'success' },
                  { name: 'terraform plan', conclusion: 'failure' },
                ],
              },
            ],
          }),
        ),
      )
      const client = createGitHubClient(createTokenCache())

      const result = await client.findFailedStep('fohte', 'example', 42)

      expect(result._unsafeUnwrap()).toEqual({
        job: 'plan (production)',
        step: 'terraform plan',
      })
    })

    it('returns null when no step failed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            jobs: [
              {
                name: 'lint',
                steps: [{ name: 'Run eslint', conclusion: 'success' }],
              },
            ],
          }),
        ),
      )
      const client = createGitHubClient(createTokenCache())

      const result = await client.findFailedStep('fohte', 'example', 42)

      expect(result._unsafeUnwrap()).toBeNull()
    })
  })

  describe('findCancelledWorkflowRun', () => {
    it('handles cancelled jobs without a steps list', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            jobs: [{ id: 123, name: 'deploy', conclusion: 'cancelled' }],
          }),
        )
        .mockResolvedValueOnce(jsonResponse([]))
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: {
          type: 'cancelled',
          step: null,
          annotationLookupError: null,
        },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=1',
        ],
      })
    })

    it('ignores annotations with a null message', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            jobs: [
              {
                id: 123,
                name: 'deploy',
                conclusion: 'cancelled',
                steps: [{ name: 'Apply changes', conclusion: 'cancelled' }],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse([{ message: null }]))
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: {
          type: 'cancelled',
          step: { job: 'deploy', step: 'Apply changes' },
          annotationLookupError: null,
        },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=1',
        ],
      })
    })

    it('finds replacement markers after the first annotation page', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/jobs?')) {
          return Promise.resolve(
            jsonResponse({
              jobs: [
                {
                  id: 123,
                  name: 'deploy',
                  conclusion: 'cancelled',
                  steps: [],
                },
              ],
            }),
          )
        }

        return Promise.resolve(
          jsonResponse(
            url.endsWith('page=2')
              ? [
                  {
                    message:
                      'Canceling since a higher priority waiting request was received',
                  },
                ]
              : Array.from({ length: 100 }, (_, index) => ({
                  message: `Annotation ${String(index + 1)}`,
                })),
          ),
        )
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: { type: 'superseded', annotationLookupError: null },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=2',
        ],
      })
    })

    it('returns the cancelled step when annotations do not indicate replacement', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            jobs: [
              {
                id: 123,
                name: 'deploy',
                steps: [
                  { name: 'Checkout', conclusion: 'success' },
                  { name: 'Apply changes', conclusion: 'cancelled' },
                ],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            {
              message:
                'The job has exceeded the maximum execution time of 15m0s',
            },
          ]),
        )
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: {
          type: 'cancelled',
          step: { job: 'deploy', step: 'Apply changes' },
          annotationLookupError: null,
        },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=1',
        ],
      })
    })

    it('keeps the cancelled step when an annotation lookup fails', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            jobs: [
              {
                id: 123,
                name: 'deploy',
                steps: [{ name: 'Apply changes', conclusion: 'cancelled' }],
              },
              {
                id: 124,
                name: 'verify',
                steps: [{ name: 'Check output', conclusion: 'cancelled' }],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse(undefined, 403))
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: {
          type: 'cancelled',
          step: { job: 'deploy', step: 'Apply changes' },
          annotationLookupError: new GitHubApiError(
            'GitHub API returned HTTP 403: /repos/example-owner/example-repo/check-runs/124/annotations?per_page=100&page=1',
            undefined,
          ),
        },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/124/annotations?per_page=100&page=1',
        ],
      })
    })

    it('marks runs with no jobs as superseded without requesting annotations', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: { type: 'superseded', annotationLookupError: null },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
        ],
      })
    })

    it('finds concurrency cancellations after the first jobs page', async () => {
      const firstPageJobs = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: `job-${String(index + 1)}`,
        conclusion: 'success',
        steps: [],
      }))
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/jobs?')) {
          return Promise.resolve(
            jsonResponse(
              url.endsWith('page=1')
                ? { jobs: firstPageJobs }
                : {
                    jobs: [
                      {
                        id: 101,
                        name: 'job-101',
                        conclusion: 'cancelled',
                        steps: [],
                      },
                    ],
                  },
            ),
          )
        }

        return Promise.resolve(
          jsonResponse(
            url.includes('/check-runs/101/annotations')
              ? [
                  {
                    message:
                      'Canceling since a higher priority waiting request was received',
                  },
                ]
              : [],
          ),
        )
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )
      const urls = fetchMock.mock.calls.map(([url]) => String(url))

      expect(
        observeCancellationPagination(result._unsafeUnwrap(), urls),
      ).toEqual({
        result: { type: 'superseded', annotationLookupError: null },
        jobPages: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=2',
        ],
        lateJobAnnotationCalls: [
          'https://api.github.com/repos/example-owner/example-repo/check-runs/101/annotations?per_page=100&page=1',
        ],
        annotationRequestCount: 1,
      })
    })

    it('marks runs with a higher priority cancellation annotation as superseded', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            jobs: [
              {
                id: 123,
                name: 'build',
                steps: [{ name: 'Build', conclusion: 'cancelled' }],
              },
              {
                id: 124,
                name: 'deploy',
                steps: [{ name: 'Deploy', conclusion: 'cancelled' }],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([{ message: 'Other cancellation' }]),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            {
              message:
                'Canceling since a higher priority waiting request was received',
            },
          ]),
        )
      vi.stubGlobal('fetch', fetchMock)
      const client = createGitHubClient(createTokenCache())

      const result = await client.findCancelledWorkflowRun(
        'example-owner',
        'example-repo',
        42,
      )

      expect(
        observeCancelledRun(
          result._unsafeUnwrap(),
          fetchMock.mock.calls.map(([url]) => String(url)),
        ),
      ).toEqual({
        result: { type: 'superseded', annotationLookupError: null },
        urls: [
          'https://api.github.com/repos/example-owner/example-repo/actions/runs/42/jobs?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/123/annotations?per_page=100&page=1',
          'https://api.github.com/repos/example-owner/example-repo/check-runs/124/annotations?per_page=100&page=1',
        ],
      })
    })
  })

  it('propagates a token acquisition failure as a GitHubAuthError', async () => {
    const tokenCache = createTokenCache({
      getToken: errAsync(new OctoStsError('boom', undefined)),
    })
    const client = createGitHubClient(tokenCache)

    const result = await client.findFailedStep('fohte', 'example', 42)

    expect(result._unsafeUnwrapErr()).toEqual(
      new GitHubAuthError(
        'failed to obtain a GitHub API token',
        new OctoStsError('boom', undefined),
      ),
    )
  })

  it('returns a GitHubApiError when the GitHub API responds with a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(undefined, 404)),
    )
    const client = createGitHubClient(createTokenCache())

    const result = await client.findFailedStep('fohte', 'example', 42)

    expect(result._unsafeUnwrapErr()).toEqual(
      new GitHubApiError(
        'GitHub API returned HTTP 404: /repos/fohte/example/actions/runs/42/jobs?per_page=100',
        undefined,
      ),
    )
  })
})
