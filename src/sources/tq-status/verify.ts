import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type { SourceContext, WebhookHeaders } from '#webhook-source'

export const extractTqStatusContext = (
  headers: WebhookHeaders,
): SourceContext | null => {
  if (headers.get('X-Tq-Signature-256') === null) return null
  return { deliveryId: randomUUID(), eventName: 'task.status_changed' }
}

export const verifyTqStatusSignature = (
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
): boolean => {
  const signature = headers.get('X-Tq-Signature-256')
  if (signature === null || !/^sha256=[\da-f]{64}$/i.test(signature)) {
    return false
  }

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex')
  if (actual.length !== expected.length) return false

  return timingSafeEqual(expected, actual)
}
