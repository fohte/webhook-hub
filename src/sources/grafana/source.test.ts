import { createHmac } from 'node:crypto'

import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import type { TqClient } from '#plugins/tq/tq-client'
import { createApp } from '#server'
import type { SlackNotifier } from '#slack'
import { createGrafanaSource } from '#sources/grafana/index'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const SECRET = 'grafana-route-test-secret'
const BODY = '{"alerts":[]}'
const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000009',
  number: 9,
}

const signatureFor = (body: string): string =>
  createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')

const createNotifier = () => {
  const postMessage = vi
    .fn<SlackNotifier['postMessage']>()
    .mockReturnValue(okAsync({ channel: 'C1', ts: '1' }))
  const notifier: SlackNotifier = {
    postMessage,
    updateMessage: vi.fn().mockReturnValue(okAsync(undefined)),
    findMessageByMetadata: vi.fn().mockReturnValue(okAsync(null)),
  }
  return { notifier, postMessage }
}

const createTqClient = (): TqClient => ({
  createTask: vi.fn().mockReturnValue(okAsync(TQ_TASK_REF)),
})

const observeResponses = async (
  validResponse: Response,
  invalidResponse: Response,
  postCalls: unknown,
) => ({
  responses: [
    { status: validResponse.status, body: await validResponse.json() },
    { status: invalidResponse.status, body: await invalidResponse.json() },
  ],
  postCalls,
})

describe('Grafana webhook source', () => {
  it('mounts POST /grafana and rejects an invalid signature', async () => {
    const { notifier, postMessage } = createNotifier()
    const app = createApp({
      sources: [
        createGrafanaSource(
          SECRET,
          createTqClient(),
          'https://tasks.example.test',
        ),
      ],
      notifier,
    })

    const validResponse = await app.request('/grafana', {
      method: 'POST',
      headers: {
        'X-Grafana-Alerting-Signature': signatureFor(BODY),
      },
      body: BODY,
    })
    const invalidResponse = await app.request('/grafana', {
      method: 'POST',
      headers: {
        'X-Grafana-Alerting-Signature': '0'.repeat(64),
      },
      body: BODY,
    })

    expect(
      await observeResponses(
        validResponse,
        invalidResponse,
        postMessage.mock.calls,
      ),
    ).toEqual({
      responses: [
        { status: 200, body: { ok: true, outcome: 'ignored' } },
        { status: 401, body: { error: 'invalid signature' } },
      ],
      postCalls: [],
    })
  })
})
