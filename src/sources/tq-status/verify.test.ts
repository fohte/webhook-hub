import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  extractTqStatusContext,
  verifyTqStatusSignature,
} from '#sources/tq-status/verify'
import type { WebhookHeaders } from '#webhook-source'

const SECRET = 'tq-test-secret'
const BODY = '{"event":"task.status_changed"}'

const signatureFor = (body: string, secret: string): string =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

const headersFrom = (values: Record<string, string>): WebhookHeaders => ({
  get: (name) => values[name] ?? null,
})

describe('extractTqStatusContext', () => {
  it('requires the signature header', () => {
    expect(extractTqStatusContext(headersFrom({}))).toEqual(null)
  })

  it('assigns a request ID for a signed webhook', () => {
    const context = extractTqStatusContext(
      headersFrom({ 'X-Tq-Signature-256': signatureFor(BODY, SECRET) }),
    )

    expect(
      context === null ? null : { ...context, deliveryId: 'request-id' },
    ).toEqual({
      deliveryId: 'request-id',
      eventName: 'task.status_changed',
    })
  })
})

describe('verifyTqStatusSignature', () => {
  it('accepts a valid sha256-prefixed signature', () => {
    expect(
      verifyTqStatusSignature(
        BODY,
        headersFrom({ 'X-Tq-Signature-256': signatureFor(BODY, SECRET) }),
        SECRET,
      ),
    ).toEqual(true)
  })

  it('rejects a signature computed with the wrong secret', () => {
    expect(
      verifyTqStatusSignature(
        BODY,
        headersFrom({
          'X-Tq-Signature-256': signatureFor(BODY, 'other-secret'),
        }),
        SECRET,
      ),
    ).toEqual(false)
  })

  it('rejects an invalid signature format', () => {
    expect(
      verifyTqStatusSignature(
        BODY,
        headersFrom({ 'X-Tq-Signature-256': 'sha256=short' }),
        SECRET,
      ),
    ).toEqual(false)
  })
})
