import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import type { SlackNotifier } from '#slack'
import { SlackApiError } from '#slack'
import type {
  DispatchOutcome,
  WebhookHeaders,
  WebhookSource,
} from '#webhook-source'
import { runWebhookSource } from '#webhook-source'

const headersFrom = (values: Record<string, string>): WebhookHeaders => ({
  get: (name) => values[name] ?? null,
})

const createNotifier = (): SlackNotifier => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  findMessageByMetadata: vi.fn(),
})

// Returns the verify/dispatch mocks alongside the source so tests can assert
// on them directly, without extracting bound methods off `source`.
const createDummySource = () => {
  const verify = vi.fn((): boolean => true)
  const dispatch = vi.fn((): ResultAsync<DispatchOutcome, SlackApiError> =>
    okAsync('notified'),
  )
  const source: WebhookSource = {
    name: 'dummy',
    path: '/dummy',
    extractContext: (headers) => {
      const deliveryId = headers.get('x-dummy-delivery')
      const eventName = headers.get('x-dummy-event')
      if (deliveryId === null || eventName === null) return null
      return { deliveryId, eventName }
    },
    verify,
    dispatch,
  }
  return { source, verify, dispatch }
}

describe('runWebhookSource', () => {
  it('short-circuits verify and dispatch when extractContext returns null', async () => {
    const { source, verify, dispatch } = createDummySource()
    const notifier = createNotifier()

    const result = await runWebhookSource(
      source,
      '{}',
      headersFrom({}),
      {},
      notifier,
    )

    expect(result).toEqual({ status: 'unrecognized' })
    expect(verify.mock.calls).toEqual([])
    expect(dispatch.mock.calls).toEqual([])
  })

  it('calls verify and dispatch when extractContext returns a context', async () => {
    const { source, verify, dispatch } = createDummySource()
    const notifier = createNotifier()
    const headers = headersFrom({
      'x-dummy-delivery': 'delivery-1',
      'x-dummy-event': 'push',
    })
    const payload = { ok: true }
    const context = { deliveryId: 'delivery-1', eventName: 'push' }

    const result = await runWebhookSource(
      source,
      '{}',
      headers,
      payload,
      notifier,
    )

    expect(result).toEqual({
      status: 'dispatched',
      context,
      outcome: 'notified',
    })
    expect(verify.mock.calls).toEqual([['{}', headers, context]])
    expect(dispatch.mock.calls).toEqual([[context, payload, notifier]])
  })

  it('returns status error with the failure when dispatch fails', async () => {
    const { source, dispatch } = createDummySource()
    const dispatchErr = new SlackApiError('boom')
    dispatch.mockReturnValue(errAsync(dispatchErr))
    const notifier = createNotifier()
    const headers = headersFrom({
      'x-dummy-delivery': 'delivery-1',
      'x-dummy-event': 'push',
    })

    const result = await runWebhookSource(
      source,
      '{}',
      headers,
      { ok: true },
      notifier,
    )

    expect(result).toEqual({
      status: 'error',
      context: { deliveryId: 'delivery-1', eventName: 'push' },
      error: dispatchErr,
    })
  })
})
