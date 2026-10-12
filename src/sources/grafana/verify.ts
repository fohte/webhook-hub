import { createHmac, timingSafeEqual } from 'node:crypto'

import type { SourceContext, WebhookHeaders } from '#webhook-source'

export const extractGrafanaContext = (): SourceContext => ({
  deliveryId: 'grafana',
  eventName: 'alerting',
})

export const verifyGrafanaSignature = (
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
): boolean => {
  const signature = headers.get('X-Grafana-Alerting-Signature')
  if (signature === null || !/^[\da-f]{64}$/i.test(signature)) return false

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  const actual = Buffer.from(signature, 'hex')
  if (actual.length !== expected.length) return false

  return timingSafeEqual(expected, actual)
}
