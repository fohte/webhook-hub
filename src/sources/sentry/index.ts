import type { TqClient } from '#plugins/tq/tq-client'
import { dispatch } from '#sources/sentry/dispatch'
import {
  extractSentryContext,
  verifySentrySignature,
} from '#sources/sentry/verify'
import type { WebhookSource } from '#webhook-source'

export const createSentrySource = (
  webhookSecret: string,
  tqClient: TqClient,
  tqWebUrl: string,
): WebhookSource => ({
  name: 'sentry',
  path: '/sentry',
  extractContext: extractSentryContext,
  verify: (rawBody, headers) =>
    verifySentrySignature(rawBody, headers, webhookSecret),
  dispatch: (context, payload, notifier) =>
    dispatch(
      { deliveryId: context.deliveryId, notifier, tqClient, tqWebUrl },
      { resource: context.eventName, payload },
    ),
})
