import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import type { ZodType } from 'zod'

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

const requestJson = <T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  schema: ZodType<T>,
  invalidResponseMessage: string,
): ResultAsync<T, TqApiError> =>
  ResultAsync.fromPromise(
    Promise.resolve().then(() =>
      fetchImpl(url, {
        ...init,
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
      const parsed = schema.safeParse(body)
      if (!parsed.success) {
        return errAsync(new TqApiError(invalidResponseMessage, parsed.error))
      }
      return okAsync(parsed.data)
    })
  })

export const createTqClient = (
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): TqClient => {
  const apiBaseUrl = apiUrl.replace(/\/+$/, '')
  const tasksUrl = `${apiBaseUrl}/api/tasks`

  return {
    createTask(request) {
      return requestJson(
        fetchImpl,
        tasksUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-author': 'service:webhook-hub',
          },
          body: JSON.stringify(request),
        },
        CreateTaskResponse,
        'TQ API returned an invalid task response',
      ).map(({ id, number }) => ({ id, number }))
    },
    findTaskByGithubUrl(url) {
      const lookupUrl = `${apiBaseUrl}/api/github/link?url=${encodeURIComponent(url)}`

      return requestJson(
        fetchImpl,
        lookupUrl,
        { method: 'GET', headers: { 'x-author': 'service:webhook-hub' } },
        GithubLinkLookupResponse,
        'TQ API returned an invalid GitHub link response',
      ).map(({ task }) =>
        task === null ? null : { id: task.id, number: task.number },
      )
    },
  }
}
