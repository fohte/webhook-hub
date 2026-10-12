import type { TqClient } from '#plugins/tq/tq-client'
import { dispatch } from '#sources/grafana/dispatch'
import {
  extractGrafanaContext,
  verifyGrafanaSignature,
} from '#sources/grafana/verify'
import type { WebhookSource } from '#webhook-source'

export const createGrafanaSource = (
  webhookSecret: string,
  tqClient: TqClient,
  tqWebUrl: string,
): WebhookSource => ({
  name: 'grafana',
  path: '/grafana',
  extractContext: extractGrafanaContext,
  verify: (rawBody, headers) =>
    verifyGrafanaSignature(rawBody, headers, webhookSecret),
  dispatch: (context, payload, notifier) =>
    dispatch(
      {
        deliveryId: context.deliveryId,
        eventName: context.eventName,
        notifier,
        tqClient,
        tqWebUrl,
      },
      payload,
    ),
})
