import { dispatchTqTaskStatusChanged } from '#sources/tq-status/dispatch'
import {
  extractTqStatusContext,
  verifyTqStatusSignature,
} from '#sources/tq-status/verify'
import type { WebhookSource } from '#webhook-source'

export const createTqStatusSource = (
  webhookSecret: string,
  tqWebUrl: string,
): WebhookSource => ({
  name: 'tq',
  path: '/tq',
  extractContext: extractTqStatusContext,
  verify: (rawBody, headers) =>
    verifyTqStatusSignature(rawBody, headers, webhookSecret),
  dispatch: (_context, payload, notifier) =>
    dispatchTqTaskStatusChanged(notifier, tqWebUrl, payload),
})
