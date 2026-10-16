import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { createApp, WebhookDispatchError } from '#server'
import { requestJson, requestText } from '#server-test-support'
import type { SlackNotifier } from '#slack'
import { SlackApiError } from '#slack'
import type { DispatchOutcome, WebhookSource } from '#webhook-source'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const createNotifier = (): SlackNotifier => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  findMessageByMetadata: vi.fn(),
  uploadImage: vi.fn(),
})

const defaultExtractContext: WebhookSource['extractContext'] = (headers) => {
  const deliveryId = headers.get('x-delivery')
  const eventName = headers.get('x-event')
  if (deliveryId === null || eventName === null) return null
  return { deliveryId, eventName }
}

const createSource = (overrides: {
  name?: string
  path?: string
  acknowledgeBeforeDispatch?: boolean
  extractContext?: WebhookSource['extractContext']
  verify: () => boolean
  dispatch: () => ResultAsync<DispatchOutcome, SlackApiError>
}): WebhookSource => ({
  name: overrides.name ?? 'dummy',
  path: overrides.path ?? '/dummy',
  acknowledgeBeforeDispatch: overrides.acknowledgeBeforeDispatch ?? false,
  extractContext: overrides.extractContext ?? defaultExtractContext,
  verify: overrides.verify,
  dispatch: overrides.dispatch,
})

const validHeaders = { 'x-delivery': 'delivery-1', 'x-event': 'push' }

const observeWithEvents = <TResult>(result: TResult, events: string[]) => ({
  result,
  events,
})

const observeDispatchReport = <TResult, TCaptures>(
  result: TResult,
  captureCalls: TCaptures,
) => ({ result, captureCalls })

describe('createApp', () => {
  it('responds to GET /healthz', async () => {
    const app = createApp({ sources: [], notifier: createNotifier() })

    const result = await requestText(app, '/healthz')

    expect(result).toEqual({ status: 200, body: 'ok' })
  })

  it('returns 200 with the outcome when dispatch succeeds', async () => {
    const source = createSource({
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(result).toEqual({
      status: 200,
      body: { ok: true, outcome: 'notified' },
    })
  })

  it('returns 400 when required headers are missing', async () => {
    const source = createSource({
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      body: '{}',
    })

    expect(result).toEqual({
      status: 400,
      body: { error: 'missing required headers' },
    })
  })

  it('returns 401 when signature verification fails', async () => {
    const source = createSource({
      verify: () => false,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(result).toEqual({
      status: 401,
      body: { error: 'invalid signature' },
    })
  })

  it('returns 401 when verify throws', async () => {
    const source = createSource({
      verify: () => {
        throw new Error('boom')
      },
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(result).toEqual({
      status: 401,
      body: { error: 'invalid signature' },
    })
  })

  it('returns 400 when the body is not valid JSON', async () => {
    const source = createSource({
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: 'not json',
    })

    expect(result).toEqual({
      status: 400,
      body: { error: 'invalid json' },
    })
  })

  it('returns 200 with outcome error when dispatch fails', async () => {
    const source = createSource({
      verify: () => true,
      dispatch: () => errAsync(new SlackApiError('boom')),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(result).toEqual({
      status: 200,
      body: { ok: false, outcome: 'error' },
    })
  })

  it('acknowledges before dispatch for sources with a short deadline', async () => {
    const dispatchStarted = Promise.withResolvers<undefined>()
    const events: string[] = []
    const source = createSource({
      acknowledgeBeforeDispatch: true,
      verify: () => true,
      dispatch: () => {
        events.push('dispatch_started')
        dispatchStarted.resolve(undefined)
        return okAsync('notified')
      },
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const resultPromise = requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    }).then((result) => {
      events.push('response_returned')
      return result
    })
    await dispatchStarted.promise

    expect(observeWithEvents(await resultPromise, events)).toEqual({
      result: { status: 200, body: { ok: true } },
      events: ['response_returned', 'dispatch_started'],
    })
  })

  it('reports dispatch failures to Sentry after acknowledging the request', async () => {
    const dispatchErr = new SlackApiError('boom')
    const reported = Promise.withResolvers<undefined>()
    vi.mocked(captureWithFingerprint).mockImplementation(() => {
      reported.resolve(undefined)
    })
    const source = createSource({
      acknowledgeBeforeDispatch: true,
      verify: () => true,
      dispatch: () => errAsync(dispatchErr),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })
    await reported.promise

    expect(
      observeDispatchReport(
        result,
        vi.mocked(captureWithFingerprint).mock.calls,
      ),
    ).toEqual({
      result: { status: 200, body: { ok: true } },
      captureCalls: [
        [
          new WebhookDispatchError(
            'failed to dispatch dummy webhook',
            dispatchErr,
          ),
          'webhook-hub.webhook-dispatch-failed',
          {
            extras: {
              source: 'dummy',
              deliveryId: 'delivery-1',
              event: 'push',
            },
          },
        ],
      ],
    })
  })

  it('reports a dispatch failure to Sentry', async () => {
    const dispatchErr = new SlackApiError('boom')
    const source = createSource({
      verify: () => true,
      dispatch: () => errAsync(dispatchErr),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [
        new WebhookDispatchError(
          'failed to dispatch dummy webhook',
          dispatchErr,
        ),
        'webhook-hub.webhook-dispatch-failed',
        {
          extras: {
            source: 'dummy',
            deliveryId: 'delivery-1',
            event: 'push',
          },
        },
      ],
    ])
  })

  it('returns 404 for an unregistered path', async () => {
    const source = createSource({
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestText(app, '/unknown', {
      method: 'POST',
      body: '{}',
    })

    expect(result).toEqual({ status: 404, body: '404 Not Found' })
  })

  it('isolates a failing source from other registered sources', async () => {
    const failing = createSource({
      name: 'failing',
      path: '/failing',
      verify: () => true,
      dispatch: () => errAsync(new SlackApiError('boom')),
    })
    const healthy = createSource({
      name: 'healthy',
      path: '/healthy',
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({
      sources: [failing, healthy],
      notifier: createNotifier(),
    })

    // Exercises the failing route so its dispatch failure is in flight;
    // its own response is already covered by the "dispatch fails" test above.
    await app.request('/failing', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })
    const healthyResult = await requestJson(app, '/healthy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(healthyResult).toEqual({
      status: 200,
      body: { ok: true, outcome: 'notified' },
    })
  })

  it('returns 500 when a source handler throws unexpectedly', async () => {
    const source = createSource({
      extractContext: () => {
        throw new Error('boom')
      },
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    const result = await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(result).toEqual({
      status: 500,
      body: { error: 'internal error' },
    })
  })

  it('reports an unexpected source handler failure to Sentry', async () => {
    const thrown = new Error('boom')
    const source = createSource({
      extractContext: () => {
        throw thrown
      },
      verify: () => true,
      dispatch: () => okAsync('notified'),
    })
    const app = createApp({ sources: [source], notifier: createNotifier() })

    await requestJson(app, '/dummy', {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    })

    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [thrown, ['webhook-hub.unexpected-error', '{{ default }}']],
    ])
  })
})
