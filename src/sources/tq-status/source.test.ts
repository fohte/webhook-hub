import { createHmac } from 'node:crypto'

import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '#server'
import type { SlackNotifier } from '#slack'
import { createTqStatusSource } from '#sources/tq-status/index'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const SECRET = 'tq-route-test-secret'
const BODY = JSON.stringify({
  event: 'task.status_changed',
  occurredAt: '2026-01-02T03:04:05Z',
  task: {
    id: 'task-example-id',
    number: 101,
    status: 'completed',
    statusReason: 'completed',
  },
})

const signatureFor = (body: string): string =>
  `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`

const createNotifier = () => {
  const findMessageByMetadata = vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockReturnValue(okAsync(null))
  const updateMessage = vi
    .fn<SlackNotifier['updateMessage']>()
    .mockReturnValue(okAsync(undefined))
  const notifier: SlackNotifier = {
    postMessage: vi.fn(),
    updateMessage,
    findMessageByMetadata,
    uploadImage: vi.fn(),
  }
  return { notifier, findMessageByMetadata, updateMessage }
}

const observeRoute = (
  responses: { status: number; body: unknown }[],
  lookups: unknown[],
  updates: unknown,
) => ({ responses, lookups, updates })

describe('tq status webhook source', () => {
  it('mounts POST /tq, verifies signatures, and ignores unmatched tasks', async () => {
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier()
    const app = createApp({
      sources: [createTqStatusSource(SECRET, 'https://tasks.example.test')],
      notifier,
    })

    const validResponse = await app.request('/tq', {
      method: 'POST',
      headers: { 'X-Tq-Signature-256': signatureFor(BODY) },
      body: BODY,
    })
    const invalidResponse = await app.request('/tq', {
      method: 'POST',
      headers: { 'X-Tq-Signature-256': 'sha256=invalid' },
      body: BODY,
    })

    expect(
      observeRoute(
        [
          { status: validResponse.status, body: await validResponse.json() },
          {
            status: invalidResponse.status,
            body: await invalidResponse.json(),
          },
        ],
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      responses: [
        { status: 200, body: { ok: true, outcome: 'ignored' } },
        { status: 401, body: { error: 'invalid signature' } },
      ],
      lookups: [['alert_task', 'grafana_alert']],
      updates: [],
    })
  })
})
