import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  extractSentryContext,
  verifySentrySignature,
} from '#sources/sentry/verify'
import type { WebhookHeaders } from '#webhook-source'

const SECRET = 'test-secret'
const BODY = '{"action":"triggered"}'

const signatureFor = (body: string, secret: string): string =>
  createHmac('sha256', secret).update(body, 'utf8').digest('hex')

const headersFrom = (values: Record<string, string>): WebhookHeaders => ({
  get: (name) => values[name] ?? null,
})

describe('extractSentryContext', () => {
  it('returns deliveryId and eventName when required headers are present', () => {
    const headers = headersFrom({
      'Request-ID': 'req-1',
      'Sentry-Hook-Resource': 'event_alert',
    })

    expect(extractSentryContext(headers)).toEqual({
      deliveryId: 'req-1',
      eventName: 'event_alert',
    })
  })

  it.each([
    {
      name: 'Request-ID is missing',
      values: { 'Sentry-Hook-Resource': 'event_alert' },
    },
    {
      name: 'Sentry-Hook-Resource is missing',
      values: { 'Request-ID': 'req-1' },
    },
  ])('returns null when $name', ({ values }) => {
    expect(extractSentryContext(headersFrom(values))).toBeNull()
  })
})

describe('verifySentrySignature', () => {
  it('returns true for a valid signature', () => {
    const headers = headersFrom({
      'Sentry-Hook-Signature': signatureFor(BODY, SECRET),
    })

    expect(verifySentrySignature(BODY, headers, SECRET)).toBe(true)
  })

  it('returns false for a signature computed with the wrong secret', () => {
    const headers = headersFrom({
      'Sentry-Hook-Signature': signatureFor(BODY, 'wrong-secret'),
    })

    expect(verifySentrySignature(BODY, headers, SECRET)).toBe(false)
  })

  it('returns false for a tampered signature of the same length', () => {
    const valid = signatureFor(BODY, SECRET)
    const tampered = `${valid.slice(0, -1)}${valid.at(-1) === '0' ? '1' : '0'}`
    const headers = headersFrom({ 'Sentry-Hook-Signature': tampered })

    expect(verifySentrySignature(BODY, headers, SECRET)).toBe(false)
  })

  it('returns false without throwing when the signature length differs from expected', () => {
    const headers = headersFrom({ 'Sentry-Hook-Signature': 'short' })

    expect(verifySentrySignature(BODY, headers, SECRET)).toBe(false)
  })

  it('returns false when the signature header is missing', () => {
    expect(verifySentrySignature(BODY, headersFrom({}), SECRET)).toBe(false)
  })
})
