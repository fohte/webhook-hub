import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task'
import {
  formatTqTaskStatus,
  type TqTaskStatusInfo,
  updateTqTaskStatus,
} from '#plugins/tq/alert-task'
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

const sourceContent: SlackMessageContent = {
  text: 'Alert details',
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
  ],
}

const originalContent: SlackMessageContent = {
  ...sourceContent,
  text: `Alert details\n未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
  blocks: [
    ...(sourceContent.blocks ?? []).slice(0, 2),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*状態*\n未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
        },
      ],
    },
    ...(sourceContent.blocks ?? []).slice(2),
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
      expected: {
        result: 'notified',
        lookups: [['alert_task', 'grafana_alert']],
        updates: [
          [
            REF,
            {
              text: [
                '*✅ ~Alert details~*',
                'Alert details',
                `対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
              ].join('\n'),
              color: '#2da44e',
              blocks: [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: '*✅ ~Alert details~*' },
                },
                {
                  type: 'context',
                  elements: [{ type: 'mrkdwn', text: 'Alert details' }],
                },
                {
                  type: 'context',
                  elements: [
                    {
                      type: 'mrkdwn',
                      text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
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
                  [TQ_ORIGINAL_CONTENT_KEY]:
                    expectedTqOriginalContentSnapshot(sourceContent),
                },
              },
            },
          ],
        ],
      },
    },
    {
      name: 'not planned',
      task: { status: 'completed', statusReason: 'not_planned' },
      expected: {
        result: 'notified',
        lookups: [['alert_task', 'grafana_alert']],
        updates: [
          [
            REF,
            {
              text: [
                '*⏭️ ~Alert details~*',
                'Alert details',
                `対応不要 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
              ].join('\n'),
              color: '#8b949e',
              blocks: [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: '*⏭️ ~Alert details~*' },
                },
                {
                  type: 'context',
                  elements: [{ type: 'mrkdwn', text: 'Alert details' }],
                },
                {
                  type: 'context',
                  elements: [
                    {
                      type: 'mrkdwn',
                      text: `対応不要 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
                    },
                  ],
                },
              ],
              metadata: {
                event_type: 'alert_task',
                event_payload: {
                  task_id: TASK_ID,
                  tq_task_status: 'completed',
                  tq_task_status_reason: 'not_planned',
                  [TQ_ORIGINAL_CONTENT_KEY]:
                    expectedTqOriginalContentSnapshot(sourceContent),
                },
              },
            },
          ],
        ],
      },
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
      expected: {
        result: 'notified',
        lookups: [['alert_task', 'grafana_alert']],
        updates: [
          [
            REF,
            {
              text: [
                '*🔁 ~Alert details~*',
                'Alert details',
                `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/${DUPLICATE_TASK_ID}|tq #${String(DUPLICATE_TASK_NUMBER)} Example task> で対応`,
              ].join('\n'),
              color: '#8b949e',
              blocks: [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: '*🔁 ~Alert details~*' },
                },
                {
                  type: 'context',
                  elements: [{ type: 'mrkdwn', text: 'Alert details' }],
                },
                {
                  type: 'context',
                  elements: [
                    {
                      type: 'mrkdwn',
                      text: `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/${DUPLICATE_TASK_ID}|tq #${String(DUPLICATE_TASK_NUMBER)} Example task> で対応`,
                    },
                  ],
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
                  tq_duplicate_task_title: 'Example task',
                  [TQ_ORIGINAL_CONTENT_KEY]:
                    expectedTqOriginalContentSnapshot(sourceContent),
                },
              },
            },
          ],
        ],
      },
    },
  ])('updates the status display for $name', async ({ task, expected }) => {
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
    ).toEqual(expected)
  })

  it('rebuilds a compact alert when only the completed reason changes', async () => {
    const completedInfo: TqTaskStatusInfo = {
      task: { id: TASK_ID, number: TASK_NUMBER },
      status: 'completed',
      statusReason: 'completed',
    }
    const completedContent = updateTqTaskStatus(
      originalContent,
      formatTqTaskStatus(completedInfo, TQ_WEB_URL),
      completedInfo,
    )
    const { notifier, findMessageByMetadata, updateMessage } = createNotifier(
      createMessage(completedContent),
    )

    const result = await dispatchTqTaskStatusChanged(
      notifier,
      TQ_WEB_URL,
      eventFor({
        status: 'completed',
        statusReason: 'duplicate',
        duplicateOfTask: {
          id: DUPLICATE_TASK_ID,
          number: DUPLICATE_TASK_NUMBER,
          title: 'Example task',
        },
      }),
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
              '*🔁 ~Alert details~*',
              'Alert details',
              `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/${DUPLICATE_TASK_ID}|tq #202 Example task> で対応`,
            ].join('\n'),
            color: '#8b949e',
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*🔁 ~Alert details~*' },
              },
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: 'Alert details' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `重複 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101> → <${TQ_WEB_URL}/tasks/${DUPLICATE_TASK_ID}|tq #202 Example task> で対応`,
                  },
                ],
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
                tq_duplicate_task_title: 'Example task',
                [TQ_ORIGINAL_CONTENT_KEY]:
                  expectedTqOriginalContentSnapshot(sourceContent),
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
                type: 'context',
                elements: [{ type: 'mrkdwn', text: 'Alert details' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
                  },
                ],
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
                [TQ_ORIGINAL_CONTENT_KEY]:
                  expectedTqOriginalContentSnapshot(sourceContent),
              },
            },
          },
        ],
      ],
    })
  })

  it('restores the snapshot and clears duplicate metadata when a task returns to todo', async () => {
    const duplicateInfo: TqTaskStatusInfo = {
      task: { id: TASK_ID, number: TASK_NUMBER },
      status: 'completed',
      statusReason: 'duplicate',
      duplicateOfTask: {
        id: DUPLICATE_TASK_ID,
        number: DUPLICATE_TASK_NUMBER,
      },
    }
    const duplicateContent = updateTqTaskStatus(
      originalContent,
      formatTqTaskStatus(duplicateInfo, TQ_WEB_URL),
      duplicateInfo,
    )
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
            text: `Alert details\n未対応 · <${TQ_WEB_URL}/tasks/${TASK_ID}|tq #101>`,
            color: '#d73a49',
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
                [TQ_ORIGINAL_CONTENT_KEY]:
                  expectedTqOriginalContentSnapshot(sourceContent),
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
