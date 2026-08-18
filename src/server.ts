import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { Hono } from 'hono'
import { Result } from 'neverthrow'

import { logger } from '#logger'
import type { SlackNotifier } from '#slack'
import type { WebhookHeaders, WebhookSourceRegistry } from '#webhook-source'

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

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text) as unknown,
  (caughtErr) => caughtErr,
)

export const createApp = (deps: CreateAppDeps): Hono => {
  const app = new Hono()

  app.onError((err, c) => {
    // catch-all handler: any error from any route can land here, so keep
    // Sentry's default grouping (exception type/value/stacktrace) alongside
    // the shared key, or unrelated errors collapse into one issue.
    captureWithFingerprint(err, [UNEXPECTED_ERROR_FINGERPRINT, '{{ default }}'])
    logger.error({ err }, 'webhook_unexpected_error')
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

      return source.dispatch(context, parsed.value, deps.notifier).match(
        (outcome) => {
          logger.info(
            {
              source: source.name,
              delivery_id: context.deliveryId,
              event: context.eventName,
              outcome,
            },
            'webhook_processed',
          )
          return c.json({ ok: true, outcome })
        },
        (dispatchErr) => {
          const wrapped = new WebhookDispatchError(
            `failed to dispatch ${source.name} webhook`,
            dispatchErr,
          )
          captureWithFingerprint(wrapped, DISPATCH_ERROR_FINGERPRINT, {
            extras: {
              source: source.name,
              deliveryId: context.deliveryId,
              event: context.eventName,
            },
          })
          logger.error(
            {
              source: source.name,
              delivery_id: context.deliveryId,
              event: context.eventName,
              err: wrapped,
            },
            'webhook_handler_error',
          )
          // Return 200 to suppress the source's redelivery; handler failures are not retried.
          return c.json({ ok: false, outcome: 'error' }, 200)
        },
      )
    })
  }

  return app
}
