import { errAsync, okAsync } from 'neverthrow'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OctoStsTokenCache } from '#auth/octo-sts'
import { OctoStsError } from '#auth/octo-sts'
import { createGitHubClient, GitHubApiError } from '#github-client'

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

describe('createGitHubClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('findPullRequestForCommit', () => {
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

  it('propagates a token acquisition failure as a GitHubApiError', async () => {
    const tokenCache = createTokenCache({
      getToken: errAsync(new OctoStsError('boom', undefined)),
    })
    const client = createGitHubClient(tokenCache)

    const result = await client.findFailedStep('fohte', 'example', 42)

    expect(result._unsafeUnwrapErr()).toEqual(
      new GitHubApiError(
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
