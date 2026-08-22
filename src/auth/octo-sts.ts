import { readFile } from 'node:fs/promises'

import { errAsync, okAsync, Result, ResultAsync } from 'neverthrow'

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

// octo-sts's actual response shape (confirmed by hitting the live endpoint):
// `expiry`, not `expires_at`, and it comes back `null` in practice.
interface ExchangeResponse {
  token: string
  expiry: string | null
}

// Refresh this far ahead of the reported expiry so a token handed to a
// caller is never used right at the edge of validity.
const SAFETY_MARGIN_MS = 5 * 60 * 1000

const isExchangeResponse = (value: unknown): value is ExchangeResponse =>
  typeof value === 'object' &&
  value !== null &&
  'token' in value &&
  typeof value.token === 'string' &&
  'expiry' in value &&
  (value.expiry === null || typeof value.expiry === 'string')

// octo-sts's `expiry` field can come back null (observed in practice) or an
// unparseable string, in which case fall back to the `exp` claim on the
// token itself, which is a JWT.
const expiryFromJwt = (token: string): number | null => {
  const payloadSegment = token.split('.')[1]
  if (payloadSegment === undefined) {
    return null
  }
  const parsed = Result.fromThrowable(
    (segment: string): unknown =>
      JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')),
    () => undefined,
  )(payloadSegment)
  if (parsed.isErr()) {
    return null
  }
  const payload = parsed.value
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('exp' in payload) ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  return payload.exp * 1000
}

const resolveExpiryMs = (res: ExchangeResponse): number | null => {
  if (res.expiry !== null) {
    const parsed = Date.parse(res.expiry)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return expiryFromJwt(res.token)
}

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
        const expiresAtMs = resolveExpiryMs(json)
        if (expiresAtMs === null) {
          return errAsync(
            new OctoStsError(
              // The token itself isn't included: it's still a live credential at
              // this point, and this error path is expected to reach Sentry.
              `octo-sts exchange returned no usable expiry (expiry: ${String(json.expiry)}, token segments: ${String(json.token.split('.').length)})`,
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
