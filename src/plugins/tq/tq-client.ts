import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import { BoundaryError } from '#errors'
import {
  type CreateTaskRequest,
  CreateTaskResponse,
  type CreateTaskResponse as CreateTaskResponseType,
  GithubLinkLookupResponse,
} from '#plugins/tq/generated/tq-contract'

export class TqApiError extends BoundaryError {}

export type TqTaskRef = Pick<CreateTaskResponseType, 'id' | 'number'>

export interface TqClient {
  createTask(request: CreateTaskRequest): ResultAsync<TqTaskRef, TqApiError>
  findTaskByGithubUrl(url: string): ResultAsync<TqTaskRef | null, TqApiError>
}

const TQ_REQUEST_TIMEOUT_MS = 10_000

export const createTqClient = (
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): TqClient => {
  const apiBaseUrl = apiUrl.replace(/\/+$/, '')
  const tasksUrl = `${apiBaseUrl}/api/tasks`

  return {
    createTask(request) {
      return ResultAsync.fromPromise(
        Promise.resolve().then(() =>
          fetchImpl(tasksUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-author': 'service:webhook-hub',
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(TQ_REQUEST_TIMEOUT_MS),
          }),
        ),
        (cause) => new TqApiError('TQ API request failed', cause),
      ).andThen((response) => {
        if (!response.ok) {
          return errAsync(
            new TqApiError(
              `TQ API returned HTTP ${String(response.status)}`,
              undefined,
            ),
          )
        }

        return ResultAsync.fromPromise(
          response.json(),
          (cause) => new TqApiError('TQ API returned malformed JSON', cause),
        ).andThen((body) => {
          const parsed = CreateTaskResponse.safeParse(body)
          if (!parsed.success) {
            return errAsync(
              new TqApiError(
                'TQ API returned an invalid task response',
                parsed.error,
              ),
            )
          }
          return okAsync({ id: parsed.data.id, number: parsed.data.number })
        })
      })
    },
    findTaskByGithubUrl(url) {
      const lookupUrl = `${apiBaseUrl}/api/github/link?url=${encodeURIComponent(url)}`

      return ResultAsync.fromPromise(
        Promise.resolve().then(() =>
          fetchImpl(lookupUrl, {
            method: 'GET',
            headers: { 'x-author': 'service:webhook-hub' },
            signal: AbortSignal.timeout(TQ_REQUEST_TIMEOUT_MS),
          }),
        ),
        (cause) => new TqApiError('TQ API request failed', cause),
      ).andThen((response) => {
        if (!response.ok) {
          return errAsync(
            new TqApiError(
              `TQ API returned HTTP ${String(response.status)}`,
              undefined,
            ),
          )
        }

        return ResultAsync.fromPromise(
          response.json(),
          (cause) => new TqApiError('TQ API returned malformed JSON', cause),
        ).andThen((body) => {
          const parsed = GithubLinkLookupResponse.safeParse(body)
          if (!parsed.success) {
            return errAsync(
              new TqApiError(
                'TQ API returned an invalid GitHub link response',
                parsed.error,
              ),
            )
          }

          const task = parsed.data.task
          return okAsync(
            task === null ? null : { id: task.id, number: task.number },
          )
        })
      })
    },
  }
}
