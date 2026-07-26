import { createHmac, timingSafeEqual } from 'node:crypto'

import type { SourceContext, WebhookHeaders } from '#webhook-source'

export const extractSentryContext = (
  headers: WebhookHeaders,
): SourceContext | null => {
  const deliveryId = headers.get('Request-ID')
  const eventName = headers.get('Sentry-Hook-Resource')
  if (deliveryId === null || eventName === null) return null
  return { deliveryId, eventName }
}

export const verifySentrySignature = (
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
): boolean => {
  const signature = headers.get('Sentry-Hook-Signature')
  if (signature === null) return false

  const expected = createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')

  // Reject an oversized signature before allocating a Buffer for it, so an
  // attacker can't force large allocations via the signature header alone.
  if (signature.length !== expected.length) return false

  const expectedBuffer = Buffer.from(expected, 'utf8')
  const actualBuffer = Buffer.from(signature, 'utf8')

  // timingSafeEqual throws on mismatched buffer lengths instead of
  // returning false, so a wrong-length signature must be rejected first.
  if (expectedBuffer.length !== actualBuffer.length) return false

  return timingSafeEqual(expectedBuffer, actualBuffer)
}
