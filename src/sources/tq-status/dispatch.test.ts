import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import {
  encodeOriginalContent,
  TQ_ORIGINAL_CONTENT_KEY,
} from '#plugins/tq/alert-task-snapshot'
import {
  expectedTqOriginalContentSnapshot,
  normalizeTqOriginalContentSnapshot,
} from '#plugins/tq/alert-task-test-support'
import type {
  SlackMessageContent,
  SlackMessageRef,
  SlackNotifier,
} from '#slack'
import { dispatchTqTaskStatusChanged } from '#sources/tq-status/dispatch'

const TASK_ID = 'task-example-id'
const TASK_NUMBER = 101
const DUPLICATE_TASK_ID = 'task-duplicate-id'
const DUPLICATE_TASK_NUMBER = 202
const TQ_WEB_URL = 'https://tasks.example.test'
const REF: SlackMessageRef = { channel: 'CEXAMPLE', ts: '123.456' }
const TASK_LINK = `<${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`
const OCCURRED_AT = '2026-01-02T03:04:05Z'
const SLACK_DATE = '<!date^1767323045^{date_short} {time}|2026-01-02 03:04 UTC>'

const sourceContent: SlackMessageContent = {
  text: 'Alert details',
  color: '#d73a49',
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: 'Alert details' } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Summary*\nExample alert details' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://alerts.example.test/1|View alert>',
        },
      ],
    },
    {
      type: 'image',
      slack_file: { id: 'FEXAMPLE' },
      alt_text: 'Example panel',
    },
  ],
}

const legacyContent: SlackMessageContent = {
  ...sourceContent,
  text: `Alert details\n未対応 · ${TASK_LINK}`,
  blocks: [
    ...(sourceContent.blocks ?? []).slice(0, 2),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*状態*\n未対応 · ${TASK_LINK}` }],
    },
    ...(sourceContent.blocks ?? []).slice(2),
  ],
  metadata: {
    event_type: 'alert_task',
    event_payload: { task_id: TASK_ID },
  },
}

const createMessage = (content: SlackMessageContent = legacyContent) => ({
  ref: REF,
  eventPayload: content.metadata?.event_payload ?? { task_id: TASK_ID },
  content,
})

const createNotifier = (
  message: ReturnType<typeof createMessage> | null = createMessage(),
) => {
  const findMessageByMetadata = vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockImplementation((eventTypes, payloadMatcher) => {
      const allowedEventTypes =
        typeof eventTypes === 'string' ? [eventTypes] : eventTypes
      const eventType = message?.content.metadata?.event_type
      return okAsync(
        message !== null &&
          eventType !== undefined &&
          allowedEventTypes.includes(eventType) &&
          payloadMatcher(message.eventPayload)
          ? message
          : null,
      )
    })
  const updateMessage = vi
    .fn<SlackNotifier['updateMessage']>()
    .mockReturnValue(okAsync(undefined))
  const notifier: SlackNotifier = {
    postMessage: vi.fn(),
    updateMessage,
    findMessageByMetadata,
    findMessagesByMetadata: vi.fn(),
    uploadImage: vi.fn(),
  }
  return { notifier, findMessageByMetadata, updateMessage }
}

const eventFor = (task: Record<string, unknown>) => ({
  event: 'task.status_changed',
  occurredAt: OCCURRED_AT,
  task: {
    id: TASK_ID,
    number: TASK_NUMBER,
    status: 'completed',
    statusReason: 'completed',
    ...task,
  },
})

const observeDispatch = (
  result: string,
  lookups: unknown[],
  updates: [SlackMessageRef, SlackMessageContent][],
) => ({
  result,
  lookups,
  updates: updates.map(([ref, content]) => [
    ref,
    normalizeTqOriginalContentSnapshot(content),
  ]),
})

describe('dispatchTqTaskStatusChanged', () => {
  it.each([
    {
      name: 'completed',
      task: { status: 'completed', statusReason: 'completed' },
      status: `~${TASK_LINK}~ · completed ${SLACK_DATE}`,
      color: '#8250df',
      reason: 'completed',
      extraMetadata: { tq_task_occurred_at: OCCURRED_AT },
    },
    {
      name: 'not planned',
      task: { status: 'completed', statusReason: 'not_planned' },
      status: `~${TASK_LINK}~ · not planned ${SLACK_DATE}`,
      color: '#6b6e75',
      reason: 'not_planned',
      extraMetadata: { tq_task_occurred_at: OCCURRED_AT },
    },
    {
      name: 'duplicate',
      task: {
        status: 'completed',
        statusReason: 'duplicate',
        duplicateOfTask: {
          id: DUPLICATE_TASK_ID,
          number: DUPLICATE_TASK_NUMBER,
          title: 'Related task',
        },
      },
      status: `~${TASK_LINK}~ · duplicate of #202 Related task`,
      color: '#6b6e75',
      reason: 'duplicate',
      extraMetadata: {
        tq_duplicate_task_id: DUPLICATE_TASK_ID,
        tq_duplicate_task_number: DUPLICATE_TASK_NUMBER,
        tq_duplicate_task_title: 'Related task',
        tq_task_occurred_at: OCCURRED_AT,
      },
    },
    {
      name: 'todo',
      task: { status: 'todo', statusReason: null },
      status: `${TASK_LINK} · todo`,
      color: '#2eb67d',
      reason: 'none',
      extraMetadata: {},
    },
  ])('updates the lower attachment for $name', async (item) => {
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier()
    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor(item.task),
    ).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventTypes]) => eventTypes),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'notified',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [
        [
          REF,
          {
            ...sourceContent,
            additionalAttachments: [
              {
                text: item.status,
                color: item.color,
                blocks: [
                  {
                    type: 'context',
                    elements: [{ type: 'mrkdwn', text: item.status }],
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: TASK_ID,
                tq_task_status: item.task.status,
                tq_task_status_reason: item.reason,
                ...item.extraMetadata,
              },
            },
          },
        ],
      ],
    })
  })

  it('finds Grafana alerts and preserves their source metadata', async () => {
    const grafanaContent: SlackMessageContent = {
      ...legacyContent,
      metadata: {
        event_type: 'grafana_alert',
        event_payload: {
          fingerprint: 'fingerprint-example',
          task_id: TASK_ID,
          task_number: TASK_NUMBER,
        },
      },
    }
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier(
      createMessage(grafanaContent),
    )
    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor({ status: 'completed', statusReason: 'completed' }),
    ).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventTypes]) => eventTypes),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'notified',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [
        [
          REF,
          {
            ...sourceContent,
            additionalAttachments: [
              {
                text: `~${TASK_LINK}~ · completed ${SLACK_DATE}`,
                color: '#8250df',
                blocks: [
                  {
                    type: 'context',
                    elements: [
                      {
                        type: 'mrkdwn',
                        text: `~${TASK_LINK}~ · completed ${SLACK_DATE}`,
                      },
                    ],
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fingerprint-example',
                task_id: TASK_ID,
                task_number: TASK_NUMBER,
                tq_task_status: 'completed',
                tq_task_status_reason: 'completed',
                tq_task_occurred_at: OCCURRED_AT,
              },
            },
          },
        ],
      ],
    })
  })

  it('ignores a status event when there is no matching alert', async () => {
    const { notifier, findMessageByMetadata, updateMessage } =
      createNotifier(null)
    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor({ status: 'completed', statusReason: 'completed' }),
    ).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventTypes]) => eventTypes),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'ignored',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [],
    })
  })

  it('ignores invalid status events without searching Slack history', async () => {
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier()
    const result = await dispatchTqTaskStatusChanged(notifier, TQ_WEB_URL, {
      event: 'other.event',
    }).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventTypes]) => eventTypes),
        updateMessage.mock.calls,
      ),
    ).toEqual({ result: 'ignored', lookups: [], updates: [] })
  })

  it('keeps the original source snapshot when updating a folded source attachment', async () => {
    const foldedContent: SlackMessageContent = {
      text: '*~Alert details~*\n<https://alerts.example.test/1|View alert>',
      color: '#2eb67d',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*~Alert details~*' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '<https://alerts.example.test/1|View alert>',
            },
          ],
        },
      ],
      additionalAttachments: [
        {
          text: `${TASK_LINK} · todo`,
          color: '#2eb67d',
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `${TASK_LINK} · todo` }],
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK_ID,
          [TQ_ORIGINAL_CONTENT_KEY]: encodeOriginalContent(sourceContent),
        },
      },
    }
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier(
      createMessage(foldedContent),
    )
    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor({ status: 'completed', statusReason: 'completed' }),
    ).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventTypes]) => eventTypes),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'notified',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [
        [
          REF,
          {
            ...foldedContent,
            additionalAttachments: [
              {
                text: `~${TASK_LINK}~ · completed ${SLACK_DATE}`,
                color: '#8250df',
                blocks: [
                  {
                    type: 'context',
                    elements: [
                      {
                        type: 'mrkdwn',
                        text: `~${TASK_LINK}~ · completed ${SLACK_DATE}`,
                      },
                    ],
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: TASK_ID,
                tq_task_status: 'completed',
                tq_task_status_reason: 'completed',
                tq_task_occurred_at: OCCURRED_AT,
                [TQ_ORIGINAL_CONTENT_KEY]:
                  expectedTqOriginalContentSnapshot(sourceContent),
              },
            },
          },
        ],
      ],
    })
  })
})
