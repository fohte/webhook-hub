import { readFile } from 'node:fs/promises'

import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import { BoundaryError } from '#errors'

export class OctoStsError extends BoundaryError {}

export interface OctoStsConfig {
  url: string
  scope: string
  identity: string
  saTokenPath: string
}

export interface OctoStsTokenCache {
  getToken(): ResultAsync<string, OctoStsError>
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

interface ExchangeResponse {
  token: string
  expires_at: string
}

// Refresh this far ahead of the reported expiry so a token handed to a
// caller is never used right at the edge of validity.
const SAFETY_MARGIN_MS = 5 * 60 * 1000

const isExchangeResponse = (value: unknown): value is ExchangeResponse =>
  typeof value === 'object' &&
  value !== null &&
  'token' in value &&
  typeof value.token === 'string' &&
  'expires_at' in value &&
  typeof value.expires_at === 'string'

export const createOctoStsTokenCache = (
  config: OctoStsConfig,
): OctoStsTokenCache => {
  let cached: CachedToken | null = null

  const exchange = (): ResultAsync<CachedToken, OctoStsError> =>
    ResultAsync.fromPromise(
      readFile(config.saTokenPath, 'utf-8'),
      (cause) =>
        new OctoStsError(
          `failed to read SA token at ${config.saTokenPath}`,
          cause,
        ),
    )
      .map((raw) => raw.trim())
      .andThen((saToken) => {
        if (saToken === '') {
          return errAsync(
            new OctoStsError(
              `SA token at ${config.saTokenPath} is empty`,
              undefined,
            ),
          )
        }
        const url = new URL('/sts/exchange', config.url)
        url.searchParams.set('scope', config.scope)
        url.searchParams.set('identity', config.identity)
        return ResultAsync.fromPromise(
          fetch(url.toString(), {
            headers: {
              authorization: `Bearer ${saToken}`,
              accept: 'application/json',
            },
          }),
          (cause) => new OctoStsError('octo-sts exchange network error', cause),
        )
      })
      .andThen((res) => {
        if (!res.ok) {
          return errAsync(
            new OctoStsError(
              `octo-sts exchange failed: HTTP ${String(res.status)}`,
              undefined,
            ),
          )
        }
        return ResultAsync.fromPromise(
          res.json(),
          (cause) =>
            new OctoStsError(
              'octo-sts exchange returned malformed body',
              cause,
            ),
        )
      })
      .andThen((json) => {
        if (!isExchangeResponse(json)) {
          return errAsync(
            new OctoStsError(
              'octo-sts exchange returned malformed body',
              undefined,
            ),
          )
        }
        const expiresAtMs = Date.parse(json.expires_at)
        if (Number.isNaN(expiresAtMs)) {
          return errAsync(
            new OctoStsError(
              `octo-sts exchange returned invalid expires_at: ${json.expires_at}`,
              undefined,
            ),
          )
        }
        return okAsync({ token: json.token, expiresAtMs })
      })

  return {
    // ponytail: no in-flight dedup — webhook-hub processes deliveries at low
    // volume, so a duplicate exchange on a concurrent cache miss is cheap.
    // Add dedup if octo-sts load ever becomes a problem.
    getToken: () => {
      if (
        cached !== null &&
        cached.expiresAtMs - Date.now() > SAFETY_MARGIN_MS
      ) {
        return okAsync(cached.token)
      }
      return exchange().map((entry) => {
        cached = entry
        return entry.token
      })
    },
  }
}
