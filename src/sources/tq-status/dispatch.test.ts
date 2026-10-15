import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task'
import { normalizeTqOriginalContentSnapshot } from '#plugins/tq/alert-task-test-support'
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

const originalContent: SlackMessageContent = {
  text: 'Alert details\n未対応 · tq #101',
  color: '#d73a49',
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Alert details' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Summary*\nExample alert details' },
    },
    {
      type: 'image',
      slack_file: { id: 'FEXAMPLE' },
      alt_text: 'Example panel',
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*状態*\n未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
        },
      ],
    },
  ],
  metadata: {
    event_type: 'alert_task',
    event_payload: { task_id: TASK_ID },
  },
}

const createMessage = (content: SlackMessageContent = originalContent) => ({
  ref: REF,
  eventPayload: content.metadata?.event_payload ?? { task_id: TASK_ID },
  content,
})

const createNotifier = (
  firstMessage: ReturnType<typeof createMessage> | null = createMessage(),
) => {
  const findMessageByMetadata = vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockImplementation((eventTypes, payloadMatcher) => {
      const allowedEventTypes =
        typeof eventTypes === 'string' ? [eventTypes] : eventTypes
      const eventType = firstMessage?.content.metadata?.event_type
      return okAsync(
        firstMessage !== null &&
          eventType !== undefined &&
          allowedEventTypes.includes(eventType) &&
          payloadMatcher(firstMessage.eventPayload)
          ? firstMessage
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
    uploadImage: vi.fn(),
  }
  return { notifier, findMessageByMetadata, updateMessage }
}

const eventFor = (task: Record<string, unknown>) => ({
  event: 'task.status_changed',
  occurredAt: '2026-01-02T03:04:05Z',
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
      status: `対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
    },
    {
      name: 'not planned',
      task: { status: 'completed', statusReason: 'not_planned' },
      status: `対応不要 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
    },
    {
      name: 'duplicate',
      task: {
        status: 'completed',
        statusReason: 'duplicate',
        duplicateOfTask: {
          id: DUPLICATE_TASK_ID,
          number: DUPLICATE_TASK_NUMBER,
          title: 'Example task',
        },
      },
      status: `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/${DUPLICATE_TASK_ID}|tq #${String(DUPLICATE_TASK_NUMBER)} Example task>`,
    },
  ])('updates the status display for $name', async ({ task, status }) => {
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier()

    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor(task),
    ).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'notified',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [
        [
          REF,
          {
            text: [
              task.statusReason === 'not_planned'
                ? '*⏭️ ~Alert details~*'
                : task.statusReason === 'duplicate'
                  ? '*🔁 ~Alert details~*'
                  : '*✅ ~Alert details~*',
              'Alert details',
              status,
            ].join('\n'),
            color:
              task.statusReason === 'not_planned' ||
              task.statusReason === 'duplicate'
                ? '#8b949e'
                : '#2da44e',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text:
                    task.statusReason === 'not_planned'
                      ? '*⏭️ ~Alert details~*'
                      : task.statusReason === 'duplicate'
                        ? '*🔁 ~Alert details~*'
                        : '*✅ ~Alert details~*',
                },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `Alert details\n${status}`,
                },
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: TASK_ID,
                tq_task_status: task.status,
                tq_task_status_reason: task.statusReason,
                ...(task.duplicateOfTask === undefined
                  ? {}
                  : {
                      tq_duplicate_task_id: task.duplicateOfTask.id,
                      tq_duplicate_task_number: task.duplicateOfTask.number,
                      tq_duplicate_task_title: task.duplicateOfTask.title,
                    }),
                [TQ_ORIGINAL_CONTENT_KEY]: '<compressed original content>',
              },
            },
          },
        ],
      ],
    })
  })

  it('finds Grafana notifications by task ID', async () => {
    const grafanaMessage = createMessage({
      ...originalContent,
      metadata: {
        event_type: 'grafana_alert',
        event_payload: {
          fingerprint: 'fingerprint-example',
          starts_at: '2026-01-02T03:04:05Z',
          task_id: TASK_ID,
          task_number: TASK_NUMBER,
        },
      },
    })
    const { notifier, findMessageByMetadata, updateMessage } =
      createNotifier(grafanaMessage)

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
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'notified',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [
        [
          REF,
          {
            ...grafanaMessage.content,
            text: `*✅ ~Alert details~*\nAlert details\n対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
            color: '#2da44e',
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*✅ ~Alert details~*' },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `Alert details\n対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
                },
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fingerprint-example',
                starts_at: '2026-01-02T03:04:05Z',
                task_id: TASK_ID,
                task_number: TASK_NUMBER,
                tq_task_status: 'completed',
                tq_task_status_reason: 'completed',
                [TQ_ORIGINAL_CONTENT_KEY]: '<compressed original content>',
              },
            },
          },
        ],
      ],
    })
  })

  it('clears duplicate metadata when a task returns to todo', async () => {
    const duplicateStatus = `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/${DUPLICATE_TASK_ID}|tq #${String(DUPLICATE_TASK_NUMBER)}>`
    const duplicateContent: SlackMessageContent = {
      ...originalContent,
      text: `Alert details\n${duplicateStatus}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Alert details' },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Summary*\nExample alert details' },
        },
        {
          type: 'image',
          slack_file: { id: 'FEXAMPLE' },
          alt_text: 'Example panel',
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `*状態*\n${duplicateStatus}` }],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK_ID,
          tq_task_status: 'completed',
          tq_task_status_reason: 'duplicate',
          tq_duplicate_task_id: DUPLICATE_TASK_ID,
          tq_duplicate_task_number: DUPLICATE_TASK_NUMBER,
        },
      },
    }
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier(
      createMessage(duplicateContent),
    )

    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor({ status: 'todo', statusReason: null }),
    ).match(
      (outcome) => outcome,
      () => 'error',
    )

    expect(
      observeDispatch(
        result,
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'notified',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [
        [
          REF,
          {
            ...duplicateContent,
            text: `Alert details\n未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Alert details' },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '*Summary*\nExample alert details',
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `*状態*\n未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
                  },
                ],
              },
              {
                type: 'image',
                slack_file: { id: 'FEXAMPLE' },
                alt_text: 'Example panel',
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: TASK_ID,
                tq_task_status: 'todo',
                tq_task_status_reason: 'none',
              },
            },
          },
        ],
      ],
    })
  })

  it('ignores events without a matching alert notification', async () => {
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
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'ignored',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [],
    })
  })

  it('ignores an invalid status event', async () => {
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
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({ result: 'ignored', lookups: [], updates: [] })
  })

  it('ignores a notification with a different task ID', async () => {
    const message = createMessage({
      ...originalContent,
      metadata: {
        event_type: 'alert_task',
        event_payload: { task_id: 'another-task-id' },
      },
    })
    const { notifier, findMessageByMetadata, updateMessage } =
      createNotifier(message)

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
        findMessageByMetadata.mock.calls.map(([eventType]) => eventType),
        updateMessage.mock.calls,
      ),
    ).toEqual({
      result: 'ignored',
      lookups: [['alert_task', 'grafana_alert']],
      updates: [],
    })
  })
})
