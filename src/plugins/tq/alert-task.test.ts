import { describe, expect, it } from 'vitest'

import {
  formatTqTaskStatus,
  readTqTaskStatusState,
  type TqTaskStatusInfo,
  updateTqTaskStatus,
} from '#plugins/tq/alert-task'
import type { SlackMessageContent } from '#slack'

const TQ_WEB_URL = 'https://tasks.example.test'
const TASK = { id: 'task-current', number: 101 }
const SNAPSHOT_KEY = 'tq_original_content_v1'
const TASK_METADATA = {
  event_type: 'alert_task',
  event_payload: { task_id: TASK.id },
} as const

const ciContent: SlackMessageContent = {
  text: '🚨 CI failed',
  color: '#d73a49',
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🚨 CI failed' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Repository*\nfohte/example' },
        {
          type: 'mrkdwn',
          text: '*起点の PR*\n<https://github.com/fohte/example/pull/42|#42 Update database>',
        },
        { type: 'mrkdwn', text: '*失敗箇所*\n`test` › `unit`' },
        { type: 'mrkdwn', text: '*トリガー*\npush' },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://github.com/fohte/example/actions/runs/7|View run>',
        },
      ],
    },
  ],
  metadata: TASK_METADATA,
}

const completedInfo: TqTaskStatusInfo = {
  task: TASK,
  status: 'completed',
  statusReason: 'completed',
}

const normalizeSnapshot = (
  content: SlackMessageContent,
): SlackMessageContent => {
  const metadata = content.metadata
  if (metadata === undefined) return content
  const snapshot = metadata.event_payload[SNAPSHOT_KEY]
  return typeof snapshot !== 'string'
    ? content
    : {
        ...content,
        metadata: {
          ...metadata,
          event_payload: {
            ...metadata.event_payload,
            [SNAPSHOT_KEY]: '<compressed original content>',
          },
        },
      }
}

describe('updateTqTaskStatus', () => {
  it('compacts a completed CI alert and changes its color', () => {
    const status = formatTqTaskStatus(completedInfo, TQ_WEB_URL)

    expect(
      normalizeSnapshot(updateTqTaskStatus(ciContent, status, completedInfo)),
    ).toEqual({
      text: [
        '*✅ ~CI failed~*',
        'fohte/example · 起点の PR <https://github.com/fohte/example/pull/42|#42 Update database>',
        `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#2da44e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*✅ ~CI failed~*' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              'fohte/example · 起点の PR <https://github.com/fohte/example/pull/42|#42 Update database>',
              `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
            ].join('\n'),
          },
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'completed',
          [SNAPSHOT_KEY]: '<compressed original content>',
        },
      },
    })
  })

  it('compacts a Sentry alert as not planned', () => {
    const content: SlackMessageContent = {
      text: '🐛 Request failed',
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🐛 Request failed' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '*アプリ*\napi' },
            { type: 'mrkdwn', text: '*Level*\nerror' },
            { type: 'mrkdwn', text: '*発生箇所*\n`request.ts`' },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '<https://sentry.example.test/issue/7|View issue>',
            },
          ],
        },
      ],
      metadata: TASK_METADATA,
    }
    const info: TqTaskStatusInfo = {
      ...completedInfo,
      statusReason: 'not_planned',
    }
    const status = formatTqTaskStatus(info, TQ_WEB_URL)

    expect(
      normalizeSnapshot(updateTqTaskStatus(content, status, info)),
    ).toEqual({
      text: [
        '*⏭️ ~Request failed~*',
        'api · <https://sentry.example.test/issue/7|View issue>',
        `対応不要 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#8b949e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*⏭️ ~Request failed~*' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              'api · <https://sentry.example.test/issue/7|View issue>',
              `対応不要 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
            ].join('\n'),
          },
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'not_planned',
          [SNAPSHOT_KEY]: '<compressed original content>',
        },
      },
    })
  })

  it('keeps Grafana status beside a duplicate link', () => {
    const content: SlackMessageContent = {
      text: '🚨 High latency',
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 High latency' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '*Grafana 上*\nfiring' },
            { type: 'mrkdwn', text: '*Severity*\ncritical' },
          ],
        },
      ],
      metadata: TASK_METADATA,
    }
    const info: TqTaskStatusInfo = {
      ...completedInfo,
      statusReason: 'duplicate',
      duplicateOfTask: {
        id: 'task-target',
        number: 202,
        title: 'Existing alert',
      },
    }
    const status = formatTqTaskStatus(info, TQ_WEB_URL)

    expect(
      normalizeSnapshot(updateTqTaskStatus(content, status, info)),
    ).toEqual({
      text: [
        '*🔁 ~High latency~*',
        'Grafana 上: firing',
        `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202 Existing alert>`,
      ].join('\n'),
      color: '#8b949e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*🔁 ~High latency~*' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              'Grafana 上: firing',
              `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202 Existing alert>`,
            ].join('\n'),
          },
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'duplicate',
          tq_duplicate_task_id: 'task-target',
          tq_duplicate_task_number: 202,
          tq_duplicate_task_title: 'Existing alert',
          [SNAPSHOT_KEY]: '<compressed original content>',
        },
      },
    })
  })

  it('restores every original field and the source color when a task returns to todo', () => {
    const completed = updateTqTaskStatus(
      ciContent,
      formatTqTaskStatus(completedInfo, TQ_WEB_URL),
      completedInfo,
    )
    const todoInfo: TqTaskStatusInfo = {
      ...completedInfo,
      status: 'todo',
      statusReason: null,
    }

    expect(
      normalizeSnapshot(
        updateTqTaskStatus(
          completed,
          formatTqTaskStatus(todoInfo, TQ_WEB_URL),
          todoInfo,
        ),
      ),
    ).toEqual({
      ...ciContent,
      text: `🚨 CI failed\n未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      blocks: [
        ...(ciContent.blocks ?? []),
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `*状態*\n未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
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
          [SNAPSHOT_KEY]: '<compressed original content>',
        },
      },
    })
  })

  it('shows only the duplicate state when the duplicate target is unavailable', () => {
    const info: TqTaskStatusInfo = {
      ...completedInfo,
      statusReason: 'duplicate',
    }

    expect(formatTqTaskStatus(info, TQ_WEB_URL)).toBe('重複')
  })
})

describe('readTqTaskStatusState', () => {
  it('keeps a duplicate target from metadata without a title', () => {
    expect(
      readTqTaskStatusState({
        tq_task_status: 'completed',
        tq_task_status_reason: 'duplicate',
        tq_duplicate_task_id: 'task-target',
        tq_duplicate_task_number: 202,
      }),
    ).toEqual({
      status: 'completed',
      statusReason: 'duplicate',
      duplicateOfTask: { id: 'task-target', number: 202 },
    })
  })

  it('formats a duplicate target without a title using its task number', () => {
    const info: TqTaskStatusInfo = {
      task: TASK,
      status: 'completed',
      statusReason: 'duplicate',
      duplicateOfTask: { id: 'task-target', number: 202 },
    }

    expect(formatTqTaskStatus(info, TQ_WEB_URL)).toBe(
      `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202>`,
    )
  })
})
