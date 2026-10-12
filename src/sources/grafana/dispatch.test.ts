import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { TqApiError, type TqClient } from '#plugins/tq/tq-client'
import type { SlackNotifier } from '#slack'
import type { DispatchContext } from '#sources/grafana/dispatch'
import { dispatch } from '#sources/grafana/dispatch'
import type { DispatchOutcome } from '#webhook-source'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000009',
  number: 9,
}
const TQ_WEB_URL = 'https://tasks.example.test'
const ALERT = {
  status: 'firing',
  labels: { alertname: 'Queue depth' },
  annotations: { summary: 'Queue is growing' },
  fingerprint: 'fp-queue',
}

const createNotifier = () => {
  const postMessage = vi
    .fn<SlackNotifier['postMessage']>()
    .mockReturnValue(okAsync({ channel: 'C1', ts: '1' }))
  const updateMessage = vi
    .fn<SlackNotifier['updateMessage']>()
    .mockReturnValue(okAsync(undefined))
  const findMessageByMetadata = vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockReturnValue(okAsync(null))
  return { postMessage, updateMessage, findMessageByMetadata }
}

const createTqClient = (
  result: ReturnType<TqClient['createTask']> = okAsync(TQ_TASK_REF),
) => ({
  createTask: vi.fn<TqClient['createTask']>().mockReturnValue(result),
})

const createContext = (
  notifier: DispatchContext['notifier'],
  tqClient = createTqClient(),
): DispatchContext => ({
  deliveryId: 'grafana',
  eventName: 'alerting',
  notifier,
  tqClient,
  tqWebUrl: TQ_WEB_URL,
})

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const matcherCalls = (
  calls: Parameters<SlackNotifier['findMessageByMetadata']>[],
): unknown[][] =>
  calls.map(([eventType, matcher]) => [
    eventType,
    matcher({ fingerprint: 'fp-queue' }),
    matcher({ fingerprint: 'another-fingerprint' }),
  ])

const observeDispatch = <TOutcome, TObservations>(
  outcome: TOutcome,
  observations: TObservations,
) => ({ outcome, ...observations })

describe('dispatch', () => {
  it('creates one tq task and posts one notification for a new fingerprint', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [ALERT],
    })

    expect(
      observeDispatch(outcome, {
        matcherCalls: matcherCalls(notifier.findMessageByMetadata.mock.calls),
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      matcherCalls: [['grafana_alert', true, false]],
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              'Labels:\n- alertname: Queue depth',
              'Annotations:\n- summary: Queue is growing',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
      updateCalls: [],
    })
  })

  it('updates a repeated fingerprint without creating another task or message', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(
      okAsync({
        ref: { channel: 'C9', ts: 'existing-ts' },
        eventPayload: {
          fingerprint: 'fp-queue',
          task_id: TQ_TASK_REF.id,
          task_number: TQ_TASK_REF.number,
        },
      }),
    )
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [{ ...ALERT, status: 'resolved' }],
    })

    expect(
      observeDispatch(outcome, {
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [],
      postCalls: [],
      updateCalls: [
        [
          { channel: 'C9', ts: 'existing-ts' },
          {
            text: '✅ Queue depth (解決)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#2da44e',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '✅ Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n解決' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
    })
  })

  it('creates one task and message for each alert in a grouped payload', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'Queue depth' },
          annotations: {},
          fingerprint: 'fp-queue',
        },
        {
          status: 'firing',
          labels: { alertname: 'Disk usage' },
          annotations: {},
          fingerprint: 'fp-disk',
        },
      ],
    })

    expect(
      observeDispatch(outcome, {
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              'Labels:\n- alertname: Queue depth',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
        [
          {
            title: 'Grafana alert: Disk usage',
            description: [
              'Alert: Disk usage',
              'Status: firing',
              'Labels:\n- alertname: Disk usage',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
        [
          {
            text: '🚨 Disk usage (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Disk usage' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-disk',
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
    })
  })

  it('posts the alert without a task link when tq task creation fails', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient(
      errAsync(new TqApiError('tq unavailable', undefined)),
    )
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [ALERT],
    })

    expect(
      observeDispatch(outcome, {
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              'Labels:\n- alertname: Queue depth',
              'Annotations:\n- summary: Queue is growing',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: '*状態*\n未対応' }],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: { fingerprint: 'fp-queue' },
            },
          },
        ],
      ],
    })
  })

  it('ignores a payload without valid Grafana alerts', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [{ status: 'pending' }],
    })

    expect(
      observeDispatch(outcome, {
        lookupCalls: notifier.findMessageByMetadata.mock.calls,
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'ignored',
      lookupCalls: [],
      taskCalls: [],
      postCalls: [],
    })
  })
})
