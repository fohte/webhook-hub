import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  extractGrafanaContext,
  verifyGrafanaSignature,
} from '#sources/grafana/verify'
import type { WebhookHeaders } from '#webhook-source'

const SECRET = 'grafana-test-secret'
const BODY = '{"alerts":[]}'

const signatureFor = (body: string, secret: string): string =>
  createHmac('sha256', secret).update(body, 'utf8').digest('hex')

const headersFrom = (values: Record<string, string>): WebhookHeaders => ({
  get: (name) => values[name] ?? null,
})

const verifyMalformedSignatures = (): boolean[] => [
  verifyGrafanaSignature(BODY, headersFrom({}), SECRET),
  verifyGrafanaSignature(
    BODY,
    headersFrom({ 'X-Grafana-Alerting-Signature': 'too-short' }),
    SECRET,
  ),
  verifyGrafanaSignature(
    BODY,
    headersFrom({ 'X-Grafana-Alerting-Signature': 'z'.repeat(64) }),
    SECRET,
  ),
]

describe('extractGrafanaContext', () => {
  it('returns the static Grafana event context', () => {
    expect(extractGrafanaContext()).toEqual({
      deliveryId: 'grafana',
      eventName: 'alerting',
    })
  })
})

describe('verifyGrafanaSignature', () => {
  it('accepts a valid hex HMAC-SHA256 signature', () => {
    expect(
      verifyGrafanaSignature(
        BODY,
        headersFrom({
          'X-Grafana-Alerting-Signature': signatureFor(BODY, SECRET),
        }),
        SECRET,
      ),
    ).toBe(true)
  })

  it('rejects a signature computed with a different secret', () => {
    expect(
      verifyGrafanaSignature(
        BODY,
        headersFrom({
          'X-Grafana-Alerting-Signature': signatureFor(BODY, 'other-secret'),
        }),
        SECRET,
      ),
    ).toBe(false)
  })

  it('rejects a missing or malformed signature', () => {
    expect(verifyMalformedSignatures()).toEqual([false, false, false])
  })
})
