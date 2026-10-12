import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import { BoundaryError } from '#errors'
import {
  type CreateTaskRequest,
  CreateTaskResponse,
  type CreateTaskResponse as CreateTaskResponseType,
} from '#plugins/tq/generated/tq-contract'

export class TqApiError extends BoundaryError {}

export type TqTaskRef = Pick<CreateTaskResponseType, 'id' | 'number'>

export interface TqClient {
  createTask(request: CreateTaskRequest): ResultAsync<TqTaskRef, TqApiError>
}

const TQ_REQUEST_TIMEOUT_MS = 10_000

export const createTqClient = (
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): TqClient => {
  const tasksUrl = `${apiUrl.replace(/\/+$/, '')}/api/tasks`

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
  }
}
