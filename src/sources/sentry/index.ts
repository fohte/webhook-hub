import { dispatch } from '#sources/sentry/dispatch'
import {
  extractSentryContext,
  verifySentrySignature,
} from '#sources/sentry/verify'
import type { WebhookSource } from '#webhook-source'

export const createSentrySource = (webhookSecret: string): WebhookSource => ({
  name: 'sentry',
  path: '/sentry',
  extractContext: extractSentryContext,
  verify: (rawBody, headers) =>
    verifySentrySignature(rawBody, headers, webhookSecret),
  dispatch: (context, payload, notifier) =>
    dispatch(
      { deliveryId: context.deliveryId, notifier },
      { resource: context.eventName, payload },
    ),
})
