import { describe, expect, it } from 'vitest'

import {
  formatTqTaskStatus,
  readTqTaskStatusState,
  type TqTaskStatusInfo,
  updateTqTaskStatus,
} from '#plugins/tq/alert-task'
import {
  encodeOriginalContent,
  TQ_ORIGINAL_CONTENT_KEY,
} from '#plugins/tq/alert-task-snapshot'
import { normalizeTqOriginalContentSnapshot } from '#plugins/tq/alert-task-test-support'
import type { SlackMessageContent } from '#slack'

const TQ_WEB_URL = 'https://tasks.example.test'
const TASK = { id: 'task-example-id', number: 101 }
const TASK_METADATA = {
  event_type: 'alert_task',
  event_payload: { task_id: TASK.id },
} as const
const SOURCE_CONTENT: SlackMessageContent = {
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
const TASK_LINK = `<${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`
const COMPLETED_AT = '2026-01-02T03:04:05Z'
const SLACK_DATE = '<!date^1767323045^{date_short} {time}|2026-01-02 03:04 UTC>'
const TODO_INFO: TqTaskStatusInfo = {
  task: TASK,
  status: 'todo',
  statusReason: null,
}
const COMPLETED_INFO: TqTaskStatusInfo = {
  task: TASK,
  status: 'completed',
  statusReason: 'completed',
  occurredAt: COMPLETED_AT,
}
const NOT_PLANNED_INFO: TqTaskStatusInfo = {
  ...COMPLETED_INFO,
  statusReason: 'not_planned',
}
const DUPLICATE_INFO: TqTaskStatusInfo = {
  ...COMPLETED_INFO,
  statusReason: 'duplicate',
  duplicateOfTask: {
    id: 'task-target-id',
    number: 202,
    title: 'Related task',
  },
}

describe('formatTqTaskStatus', () => {
  it.each([
    {
      info: TODO_INFO,
      expected: `${TASK_LINK} · todo`,
    },
    {
      info: COMPLETED_INFO,
      expected: `~${TASK_LINK}~ · completed ${SLACK_DATE}`,
    },
    {
      info: NOT_PLANNED_INFO,
      expected: `~${TASK_LINK}~ · not planned ${SLACK_DATE}`,
    },
    {
      info: DUPLICATE_INFO,
      expected: `~${TASK_LINK}~ · duplicate of #202 Related task`,
    },
  ])('formats the $info.statusReason status', ({ info, expected }) => {
    expect(formatTqTaskStatus(info, TQ_WEB_URL)).toBe(expected)
  })

  it('escapes Slack markup in a duplicate task title', () => {
    const info: TqTaskStatusInfo = {
      ...COMPLETED_INFO,
      statusReason: 'duplicate',
      duplicateOfTask: {
        id: 'task-target-id',
        number: 202,
        title: 'Review <target> & notes',
      },
    }

    expect(formatTqTaskStatus(info, TQ_WEB_URL)).toBe(
      `~${TASK_LINK}~ · duplicate of #202 Review &lt;target&gt; &amp; notes`,
    )
  })

  it('formats a duplicate target without a title using its task number', () => {
    const info: TqTaskStatusInfo = {
      ...COMPLETED_INFO,
      statusReason: 'duplicate',
      duplicateOfTask: { id: 'task-target-id', number: 202 },
    }

    expect(formatTqTaskStatus(info, TQ_WEB_URL)).toBe(
      `~${TASK_LINK}~ · duplicate of #202`,
    )
  })
})

describe('updateTqTaskStatus', () => {
  it('adds the completed task status below the unchanged source attachment', () => {
    const status = formatTqTaskStatus(COMPLETED_INFO, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(
          { ...SOURCE_CONTENT, metadata: TASK_METADATA },
          status,
          COMPLETED_INFO,
        ),
      ),
    ).toEqual({
      ...SOURCE_CONTENT,
      additionalAttachments: [
        {
          text: status,
          color: '#8250df',
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: status }],
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'completed',
          tq_task_occurred_at: COMPLETED_AT,
        },
      },
    })
  })

  it('updates only the task attachment when a task returns to todo', () => {
    const completedStatus = formatTqTaskStatus(COMPLETED_INFO, TQ_WEB_URL)
    const completed = updateTqTaskStatus(
      { ...SOURCE_CONTENT, metadata: TASK_METADATA },
      completedStatus,
      COMPLETED_INFO,
    )
    const todoStatus = formatTqTaskStatus(TODO_INFO, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(completed, todoStatus, TODO_INFO),
      ),
    ).toEqual({
      ...SOURCE_CONTENT,
      additionalAttachments: [
        {
          text: todoStatus,
          color: '#2eb67d',
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: todoStatus }],
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'todo',
          tq_task_status_reason: 'none',
        },
      },
    })
  })

  it.each([
    { name: 'missing', snapshot: undefined },
    { name: 'corrupt', snapshot: 'broken-snapshot' },
  ])(
    'recovers a previous compact alert with a $name snapshot',
    ({ snapshot }) => {
      const context = 'service · <https://alerts.example.test/42|View alert>'
      const heading = '*✅ ~Database unavailable~*'
      const status = `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`
      const legacyContent: SlackMessageContent = {
        text: [heading, context, status].join('\n'),
        color: '#2da44e',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: heading },
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: context },
              { type: 'mrkdwn', text: status },
            ],
          },
        ],
        metadata: {
          event_type: 'alert_task',
          event_payload: {
            task_id: TASK.id,
            tq_task_status: 'completed',
            tq_task_status_reason: 'completed',
            ...(snapshot === undefined
              ? {}
              : { [TQ_ORIGINAL_CONTENT_KEY]: snapshot }),
          },
        },
      }
      const todoStatus = formatTqTaskStatus(TODO_INFO, TQ_WEB_URL)

      expect(updateTqTaskStatus(legacyContent, todoStatus, TODO_INFO)).toEqual({
        text: [`*🚨 Database unavailable*`, context].join('\n'),
        color: '#d73a49',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*🚨 Database unavailable*' },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: context }],
          },
        ],
        additionalAttachments: [
          {
            text: todoStatus,
            color: '#2eb67d',
            blocks: [
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: todoStatus }],
              },
            ],
          },
        ],
        metadata: {
          event_type: 'alert_task',
          event_payload: {
            task_id: TASK.id,
            tq_task_status: 'todo',
            tq_task_status_reason: 'none',
          },
        },
      })
    },
  )

  it('moves the legacy task status out of a single attachment', () => {
    const legacyStatus = `未対応 · ${TASK_LINK}`
    const legacyContent: SlackMessageContent = {
      ...SOURCE_CONTENT,
      text: `Alert details\n${legacyStatus}`,
      blocks: [
        ...(SOURCE_CONTENT.blocks ?? []).slice(0, 2),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `*状態*\n${legacyStatus}` }],
        },
        ...(SOURCE_CONTENT.blocks ?? []).slice(2),
      ],
      metadata: TASK_METADATA,
    }
    const status = formatTqTaskStatus(COMPLETED_INFO, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(legacyContent, status, COMPLETED_INFO),
      ),
    ).toEqual({
      ...SOURCE_CONTENT,
      additionalAttachments: [
        {
          text: status,
          color: '#8250df',
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: status }],
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'completed',
          tq_task_occurred_at: COMPLETED_AT,
        },
      },
    })
  })

  it('restores a previous compact task notification from its snapshot', () => {
    const compactStatus = '対応済み'
    const legacyCompact: SlackMessageContent = {
      text: `*✅ ~Alert details~*\nAlert details\n${compactStatus}`,
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
          elements: [{ type: 'mrkdwn', text: compactStatus }],
        },
      ],
      metadata: {
        ...TASK_METADATA,
        event_payload: {
          ...TASK_METADATA.event_payload,
          [TQ_ORIGINAL_CONTENT_KEY]: encodeOriginalContent(SOURCE_CONTENT),
        },
      },
    }
    const status = formatTqTaskStatus(TODO_INFO, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(legacyCompact, status, TODO_INFO),
      ),
    ).toEqual({
      ...SOURCE_CONTENT,
      additionalAttachments: [
        {
          text: status,
          color: '#2eb67d',
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: status }],
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'todo',
          tq_task_status_reason: 'none',
        },
      },
    })
  })

  it('removes compact appearance fields absent from the restored snapshot', () => {
    const sourceContent = { text: 'Plain alert' }
    const legacyCompact: SlackMessageContent = {
      text: '*✅ ~Plain alert~*\nPlain alert',
      color: '#2da44e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*✅ ~Plain alert~*' },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Plain alert' }],
        },
      ],
      metadata: {
        ...TASK_METADATA,
        event_payload: {
          ...TASK_METADATA.event_payload,
          [TQ_ORIGINAL_CONTENT_KEY]: encodeOriginalContent(sourceContent),
        },
      },
    }
    const status = formatTqTaskStatus(TODO_INFO, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(legacyCompact, status, TODO_INFO),
      ),
    ).toEqual({
      text: 'Plain alert',
      additionalAttachments: [
        {
          text: status,
          color: '#2eb67d',
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: status }],
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'todo',
          tq_task_status_reason: 'none',
        },
      },
    })
  })
})

describe('readTqTaskStatusState', () => {
  it('reads a duplicate target and its title from metadata', () => {
    expect(
      readTqTaskStatusState({
        tq_task_status: 'completed',
        tq_task_status_reason: 'duplicate',
        tq_duplicate_task_id: 'task-target-id',
        tq_duplicate_task_number: 202,
        tq_duplicate_task_title: 'Related task',
        tq_task_occurred_at: COMPLETED_AT,
      }),
    ).toEqual({
      status: 'completed',
      statusReason: 'duplicate',
      occurredAt: COMPLETED_AT,
      duplicateOfTask: {
        id: 'task-target-id',
        number: 202,
        title: 'Related task',
      },
    })
  })

  it('returns null for a task state with an invalid reason', () => {
    expect(
      readTqTaskStatusState({
        tq_task_status: 'todo',
        tq_task_status_reason: 'duplicate',
      }),
    ).toBeNull()
  })
})
