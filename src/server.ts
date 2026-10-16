import { setImmediate } from 'node:timers/promises'

import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { Hono } from 'hono'
import { Result } from 'neverthrow'

import { logger } from '#logger'
import type { SlackNotifier } from '#slack'
import type {
  DispatchOutcome,
  SourceContext,
  WebhookHeaders,
  WebhookSourceRegistry,
} from '#webhook-source'

export interface CreateAppDeps {
  sources: WebhookSourceRegistry
  notifier: SlackNotifier
}

export class WebhookDispatchError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'WebhookDispatchError'
  }
}

const DISPATCH_ERROR_FINGERPRINT = 'webhook-hub.webhook-dispatch-failed'
const UNEXPECTED_ERROR_FINGERPRINT = 'webhook-hub.unexpected-error'
const SHUTDOWN_DISPATCH_TIMEOUT_FINGERPRINT =
  'webhook-hub.shutdown-dispatch-timeout'
const BACKGROUND_DISPATCH_DRAIN_TIMEOUT_MS = 5_000

interface PendingDispatch {
  source: string
  context: SourceContext
}

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text) as unknown,
  (caughtErr) => caughtErr,
)

const reportUnexpectedError = (
  err: unknown,
  context?: {
    source: string
    delivery_id: string
    event: string
  },
): void => {
  captureWithFingerprint(err, [UNEXPECTED_ERROR_FINGERPRINT, '{{ default }}'])
  logger.error(
    context === undefined ? { err } : { ...context, err },
    'webhook_unexpected_error',
  )
}

const reportDispatchFailure = (
  source: string,
  context: SourceContext,
  dispatchErr: unknown,
): void => {
  const wrapped = new WebhookDispatchError(
    `failed to dispatch ${source} webhook`,
    dispatchErr,
  )
  captureWithFingerprint(wrapped, DISPATCH_ERROR_FINGERPRINT, {
    extras: {
      source,
      deliveryId: context.deliveryId,
      event: context.eventName,
    },
  })
  logger.error(
    {
      source,
      delivery_id: context.deliveryId,
      event: context.eventName,
      err: wrapped,
    },
    'webhook_handler_error',
  )
}

const logDispatchSuccess = (
  source: string,
  context: SourceContext,
  outcome: DispatchOutcome,
): void => {
  logger.info(
    {
      source,
      delivery_id: context.deliveryId,
      event: context.eventName,
      outcome,
    },
    'webhook_processed',
  )
}

const dispatchAfterAcknowledgement = (
  source: WebhookSourceRegistry[number],
  context: SourceContext,
  payload: unknown,
  notifier: SlackNotifier,
): Promise<void> => {
  const reportUnexpected = (err: unknown): void => {
    reportUnexpectedError(err, {
      source: source.name,
      delivery_id: context.deliveryId,
      event: context.eventName,
    })
  }

  return setImmediate()
    .then(() =>
      source.dispatch(context, payload, notifier).match(
        (outcome) => {
          logDispatchSuccess(source.name, context, outcome)
        },
        (dispatchErr) => {
          reportDispatchFailure(source.name, context, dispatchErr)
        },
      ),
    )
    .catch(reportUnexpected)
}

export interface WebhookApp extends Hono {
  drainBackgroundDispatches(): Promise<void>
}

export const createApp = (deps: CreateAppDeps): WebhookApp => {
  const app = new Hono()
  const pendingDispatches = new Map<Promise<void>, PendingDispatch>()

  const drainBackgroundDispatches = async (): Promise<void> => {
    if (pendingDispatches.size === 0) return

    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      Promise.allSettled([...pendingDispatches.keys()]).then(() => 'drained'),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => {
          resolve('timeout')
        }, BACKGROUND_DISPATCH_DRAIN_TIMEOUT_MS)
      }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)

    if (result === 'timeout' && pendingDispatches.size > 0) {
      const dispatches = [...pendingDispatches.values()].map(
        ({ source, context }) => ({
          source,
          delivery_id: context.deliveryId,
          event: context.eventName,
        }),
      )
      const err = new Error(
        `timed out waiting for ${String(dispatches.length)} webhook dispatches during shutdown`,
      )
      captureWithFingerprint(err, SHUTDOWN_DISPATCH_TIMEOUT_FINGERPRINT, {
        extras: { dispatches },
      })
      logger.error({ dispatches, err }, 'webhook_dispatch_shutdown_timeout')
    }
  }

  const trackBackgroundDispatch = (
    source: WebhookSourceRegistry[number],
    context: SourceContext,
    payload: unknown,
  ): void => {
    const dispatch = dispatchAfterAcknowledgement(
      source,
      context,
      payload,
      deps.notifier,
    )
    const trackedDispatch = dispatch.finally(() => {
      pendingDispatches.delete(trackedDispatch)
    })
    pendingDispatches.set(trackedDispatch, { source: source.name, context })
  }

  app.onError((err, c) => {
    // catch-all handler: any error from any route can land here, so keep
    // Sentry's default grouping (exception type/value/stacktrace) alongside
    // the shared key, or unrelated errors collapse into one issue.
    reportUnexpectedError(err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/healthz', (c) => c.text('ok'))

  for (const source of deps.sources) {
    app.post(source.path, async (c) => {
      const headers: WebhookHeaders = {
        get: (name) => c.req.header(name) ?? null,
      }

      const context = source.extractContext(headers)
      if (context === null) {
        logger.warn(
          {
            source: source.name,
            reason: 'missing_headers',
          },
          'webhook_bad_request',
        )
        return c.json({ error: 'missing required headers' }, 400)
      }

      const rawBody = await c.req.text()

      // verify's contract allows a synchronous throw (@octokit/webhooks-methods
      // throws TypeError on a falsy signature) alongside a rejecting promise —
      // the async wrapper normalizes both into a single promise `.catch` can
      // collapse to false. extractContext is synchronous only; a throw there
      // propagates to the onError handler above instead.
      const verified = await (async () =>
        source.verify(rawBody, headers, context))().catch(() => false)
      if (!verified) {
        logger.warn(
          {
            source: source.name,
            delivery_id: context.deliveryId,
            event: context.eventName,
          },
          'webhook_invalid_signature',
        )
        return c.json({ error: 'invalid signature' }, 401)
      }

      const parsed = parseJson(rawBody)
      if (parsed.isErr()) {
        logger.warn(
          {
            source: source.name,
            delivery_id: context.deliveryId,
            event: context.eventName,
            err: parsed.error,
          },
          'webhook_invalid_json',
        )
        return c.json({ error: 'invalid json' }, 400)
      }

      if (source.acknowledgeBeforeDispatch === true) {
        trackBackgroundDispatch(source, context, parsed.value)
        return c.json({ ok: true })
      }

      return source.dispatch(context, parsed.value, deps.notifier).match(
        (outcome) => {
          logDispatchSuccess(source.name, context, outcome)
          return c.json({ ok: true, outcome })
        },
        (dispatchErr) => {
          reportDispatchFailure(source.name, context, dispatchErr)
          // Return 200 to suppress the source's redelivery; handler failures are not retried.
          return c.json({ ok: false, outcome: 'error' }, 200)
        },
      )
    })
  }

  return Object.assign(app, { drainBackgroundDispatches })
}
