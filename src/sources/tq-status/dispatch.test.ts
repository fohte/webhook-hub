import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import type {
  SlackMessageContent,
  SlackMessageRef,
  SlackNotifier,
} from '#slack'
import { dispatchTqTaskStatusChanged } from '#sources/tq-status/dispatch'

const TASK_ID = 'task-example-id'
const TASK_NUMBER = 101
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
  eventPayload: { task_id: TASK_ID },
  content,
})

const createNotifier = (
  firstMessage: ReturnType<typeof createMessage> | null = createMessage(),
) => {
  const findMessageByMetadata = vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockReturnValueOnce(okAsync(firstMessage))
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
  lookups: string[],
  updates: unknown,
) => ({ result, lookups, updates })

describe('dispatchTqTaskStatusChanged', () => {
  it.each([
    {
      name: 'todo',
      task: { status: 'todo', statusReason: null },
      status: `未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
    },
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
          id: 'task-duplicate-id',
          number: 202,
          title: 'Example task',
        },
      },
      status: `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/task-duplicate-id|tq #202>`,
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
      lookups: ['alert_task'],
      updates: [
        [
          REF,
          {
            ...originalContent,
            text: `Alert details\n${status}`,
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Alert details' },
              },
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `*状態*\n${status}` }],
              },
            ],
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
    const findMessageByMetadata = vi
      .fn<SlackNotifier['findMessageByMetadata']>()
      .mockReturnValueOnce(okAsync(null))
      .mockReturnValueOnce(okAsync(grafanaMessage))
    const updateMessage = vi
      .fn<SlackNotifier['updateMessage']>()
      .mockReturnValue(okAsync(undefined))
    const notifier: SlackNotifier = {
      postMessage: vi.fn(),
      updateMessage,
      findMessageByMetadata,
      uploadImage: vi.fn(),
    }

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
      lookups: ['alert_task', 'grafana_alert'],
      updates: [
        [
          REF,
          {
            ...grafanaMessage.content,
            text: `Alert details\n対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Alert details' },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `*状態*\n対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
                  },
                ],
              },
            ],
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
      lookups: ['alert_task', 'grafana_alert'],
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
})
