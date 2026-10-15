import { describe, expect, it, vi } from 'vitest'

import { logger } from '#logger'
import {
  formatTqTaskStatus,
  readTqTaskStatusState,
  TQ_ORIGINAL_CONTENT_KEY,
  type TqTaskStatusInfo,
  updateTqTaskStatus,
} from '#plugins/tq/alert-task'
import {
  expectedTqOriginalContentSnapshot,
  normalizeTqOriginalContentSnapshot,
} from '#plugins/tq/alert-task-test-support'
import type { SlackMessageContent } from '#slack'

vi.mock('#logger', () => ({ logger: { warn: vi.fn() } }))

const TQ_WEB_URL = 'https://tasks.example.test'
const TASK = { id: 'task-current', number: 101 }
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

const sentryContent: SlackMessageContent = {
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

const grafanaContent: SlackMessageContent = {
  text: '🔥 High latency',
  color: '#d73a49',
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔥 High latency' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Severity*\ncritical' },
        { type: 'mrkdwn', text: '*instance*\nservice-a' },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*概要*\nLatency is high' },
    },
  ],
  metadata: {
    event_type: 'grafana_alert',
    event_payload: { task_id: TASK.id, grafana_status: 'resolved' },
  },
}

const legacyGrafanaContent: SlackMessageContent = {
  text: '✅ Database saturation (解決)',
  color: '#2da44e',
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: '✅ Database saturation' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Grafana 上*\nresolved' },
        { type: 'mrkdwn', text: '*Severity*\ncritical' },
        { type: 'mrkdwn', text: '*instance*\nworker-3' },
      ],
    },
  ],
  metadata: {
    event_type: 'grafana_alert',
    event_payload: { task_id: TASK.id },
  },
}

const completedInfo: TqTaskStatusInfo = {
  task: TASK,
  status: 'completed',
  statusReason: 'completed',
}

const normalizeUpdates = (...contents: SlackMessageContent[]) =>
  contents.map(normalizeTqOriginalContentSnapshot)

describe('updateTqTaskStatus', () => {
  it('compacts a completed CI alert and changes its color', () => {
    const status = formatTqTaskStatus(completedInfo, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(ciContent, status, completedInfo),
      ),
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
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'fohte/example · 起点の PR <https://github.com/fohte/example/pull/42|#42 Update database>',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
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
          [TQ_ORIGINAL_CONTENT_KEY]:
            expectedTqOriginalContentSnapshot(ciContent),
        },
      },
    })
  })

  it('keeps titles with tildes inside the strikethrough', () => {
    const content: SlackMessageContent = {
      text: '🚨 CPU ~90%',
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 CPU ~90%' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '*Repository*\nexample/service' },
            { type: 'mrkdwn', text: '*起点の PR*\nなし' },
          ],
        },
      ],
      metadata: TASK_METADATA,
    }
    const status = formatTqTaskStatus(completedInfo, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(content, status, completedInfo),
      ),
    ).toEqual({
      text: [
        '*✅ ~CPU ∼90%~*',
        'example/service · 起点の PR なし',
        `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#2da44e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*✅ ~CPU ∼90%~*' },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'example/service · 起点の PR なし' },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
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
          [TQ_ORIGINAL_CONTENT_KEY]: expectedTqOriginalContentSnapshot(content),
        },
      },
    })
  })

  it('keeps leading punctuation and neutralizes mrkdwn title markers', () => {
    const content: SlackMessageContent = {
      text: '🚨 [# (Queue) *critical* _state_ `value`',
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🚨 [# (Queue) *critical* _state_ `value`',
          },
        },
      ],
      metadata: TASK_METADATA,
    }
    const status = formatTqTaskStatus(completedInfo, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(content, status, completedInfo),
      ),
    ).toEqual({
      text: [
        '*✅ ~[# (Queue) ∗critical∗ ＿state＿ ˋvalueˋ~*',
        '[# (Queue) *critical* _state_ `value`',
        `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#2da44e',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*✅ ~[# (Queue) ∗critical∗ ＿state＿ ˋvalueˋ~*',
          },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '[# (Queue) *critical* _state_ `value`' },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
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
          [TQ_ORIGINAL_CONTENT_KEY]: expectedTqOriginalContentSnapshot(content),
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
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(content, status, info),
      ),
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
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'api · <https://sentry.example.test/issue/7|View issue>',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `対応不要 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'not_planned',
          [TQ_ORIGINAL_CONTENT_KEY]: expectedTqOriginalContentSnapshot(content),
        },
      },
    })
  })

  it('compacts a completed Sentry alert with its issue context', () => {
    const status = formatTqTaskStatus(completedInfo, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(sentryContent, status, completedInfo),
      ),
    ).toEqual({
      text: [
        '*✅ ~Request failed~*',
        'api · <https://sentry.example.test/issue/7|View issue>',
        `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#2da44e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*✅ ~Request failed~*' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'api · <https://sentry.example.test/issue/7|View issue>',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
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
          [TQ_ORIGINAL_CONTENT_KEY]:
            expectedTqOriginalContentSnapshot(sentryContent),
        },
      },
    })
  })

  it.each([
    {
      name: 'completed',
      info: completedInfo,
      heading: '*✅ ~High latency~*',
      color: '#2da44e',
      state: '対応済み',
      reason: 'completed',
    },
    {
      name: 'not planned',
      info: { ...completedInfo, statusReason: 'not_planned' as const },
      heading: '*⏭️ ~High latency~*',
      color: '#8b949e',
      state: '対応不要',
      reason: 'not_planned',
    },
  ])(
    'compacts a Grafana alert as $name',
    ({ info, heading, color, state, reason }) => {
      const status = formatTqTaskStatus(info, TQ_WEB_URL)

      expect(
        normalizeTqOriginalContentSnapshot(
          updateTqTaskStatus(grafanaContent, status, info),
        ),
      ).toEqual({
        text: [
          heading,
          'Severity: critical · instance: service-a',
          `${state} · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
        ].join('\n'),
        color,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: heading } },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: 'Severity: critical · instance: service-a',
              },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${state} · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
              },
            ],
          },
        ],
        metadata: {
          event_type: 'grafana_alert',
          event_payload: {
            task_id: TASK.id,
            grafana_status: 'resolved',
            tq_task_status: 'completed',
            tq_task_status_reason: reason,
            [TQ_ORIGINAL_CONTENT_KEY]:
              expectedTqOriginalContentSnapshot(grafanaContent),
          },
        },
      })
    },
  )

  it('reads the Grafana state from legacy fields and restores resolved alerts in red', () => {
    const closed = updateTqTaskStatus(
      legacyGrafanaContent,
      formatTqTaskStatus(completedInfo, TQ_WEB_URL),
      completedInfo,
    )
    const todoInfo: TqTaskStatusInfo = {
      ...completedInfo,
      status: 'todo',
      statusReason: null,
    }
    const restored = updateTqTaskStatus(
      closed,
      formatTqTaskStatus(todoInfo, TQ_WEB_URL),
      todoInfo,
    )
    expect(normalizeUpdates(closed, restored)).toEqual([
      {
        text: [
          '*✅ ~Database saturation~*',
          'Severity: critical · instance: worker-3',
          `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
        ].join('\n'),
        color: '#2da44e',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*✅ ~Database saturation~*' },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: 'Severity: critical · instance: worker-3',
              },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
              },
            ],
          },
        ],
        metadata: {
          event_type: 'grafana_alert',
          event_payload: {
            task_id: TASK.id,
            tq_task_status: 'completed',
            tq_task_status_reason: 'completed',
            [TQ_ORIGINAL_CONTENT_KEY]:
              expectedTqOriginalContentSnapshot(legacyGrafanaContent),
          },
        },
      },
      {
        text: [
          '✅ Database saturation (解決)',
          `未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
        ].join('\n'),
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '✅ Database saturation',
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '*Grafana 上*\nresolved' },
              { type: 'mrkdwn', text: '*Severity*\ncritical' },
              { type: 'mrkdwn', text: '*instance*\nworker-3' },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `*状態*\n未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
              },
            ],
          },
        ],
        metadata: {
          event_type: 'grafana_alert',
          event_payload: {
            task_id: TASK.id,
            tq_task_status: 'todo',
            tq_task_status_reason: 'none',
            [TQ_ORIGINAL_CONTENT_KEY]:
              expectedTqOriginalContentSnapshot(legacyGrafanaContent),
          },
        },
      },
    ])
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
            { type: 'mrkdwn', text: '*Severity*\ncritical' },
            { type: 'mrkdwn', text: '*instance*\nservice-a' },
          ],
        },
      ],
      metadata: {
        event_type: 'grafana_alert',
        event_payload: {
          task_id: TASK.id,
          grafana_status: 'firing',
        },
      },
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
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(content, status, info),
      ),
    ).toEqual({
      text: [
        '*🔁 ~High latency~*',
        'Severity: critical · instance: service-a',
        `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202 Existing alert> で対応 · Grafana 上: firing`,
      ].join('\n'),
      color: '#8b949e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*🔁 ~High latency~*' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Severity: critical · instance: service-a',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202 Existing alert> で対応 · Grafana 上: firing`,
            },
          ],
        },
      ],
      metadata: {
        event_type: 'grafana_alert',
        event_payload: {
          task_id: TASK.id,
          grafana_status: 'firing',
          tq_task_status: 'completed',
          tq_task_status_reason: 'duplicate',
          tq_duplicate_task_id: 'task-target',
          tq_duplicate_task_number: 202,
          tq_duplicate_task_title: 'Existing alert',
          [TQ_ORIGINAL_CONTENT_KEY]: expectedTqOriginalContentSnapshot(content),
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
      normalizeTqOriginalContentSnapshot(
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
          [TQ_ORIGINAL_CONTENT_KEY]:
            expectedTqOriginalContentSnapshot(ciContent),
        },
      },
    })
  })

  it('restores every Sentry field when a task returns to todo', () => {
    const completed = updateTqTaskStatus(
      sentryContent,
      formatTqTaskStatus(completedInfo, TQ_WEB_URL),
      completedInfo,
    )
    const todoInfo: TqTaskStatusInfo = {
      ...completedInfo,
      status: 'todo',
      statusReason: null,
    }
    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(
          completed,
          formatTqTaskStatus(todoInfo, TQ_WEB_URL),
          todoInfo,
        ),
      ),
    ).toEqual({
      text: `🐛 Request failed\n未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      color: '#d73a49',
      blocks: [
        ...(sentryContent.blocks ?? []),
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
          [TQ_ORIGINAL_CONTENT_KEY]:
            expectedTqOriginalContentSnapshot(sentryContent),
        },
      },
    })
  })

  it('restores every Grafana field when a task returns to todo', () => {
    const completed = updateTqTaskStatus(
      grafanaContent,
      formatTqTaskStatus(completedInfo, TQ_WEB_URL),
      completedInfo,
    )
    const todoInfo: TqTaskStatusInfo = {
      ...completedInfo,
      status: 'todo',
      statusReason: null,
    }

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(
          completed,
          formatTqTaskStatus(todoInfo, TQ_WEB_URL),
          todoInfo,
        ),
      ),
    ).toEqual({
      text: `🔥 High latency\n未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🔥 High latency' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '*Severity*\ncritical' },
            { type: 'mrkdwn', text: '*instance*\nservice-a' },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*概要*\nLatency is high' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `*状態*\n未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> · Grafana 上: resolved`,
            },
          ],
        },
      ],
      metadata: {
        event_type: 'grafana_alert',
        event_payload: {
          task_id: TASK.id,
          grafana_status: 'resolved',
          tq_task_status: 'todo',
          tq_task_status_reason: 'none',
          [TQ_ORIGINAL_CONTENT_KEY]:
            expectedTqOriginalContentSnapshot(grafanaContent),
        },
      },
    })
  })

  it('keeps a corrupt snapshot unchanged and updates compact status when reopening', () => {
    const completed = updateTqTaskStatus(
      ciContent,
      formatTqTaskStatus(completedInfo, TQ_WEB_URL),
      completedInfo,
    )
    const completedMetadata = completed.metadata
    if (completedMetadata === undefined) {
      throw new Error('completed alert metadata is missing')
    }
    const corruptContent: SlackMessageContent = {
      ...completed,
      metadata: {
        ...completedMetadata,
        event_payload: {
          ...completedMetadata.event_payload,
          [TQ_ORIGINAL_CONTENT_KEY]: 'broken-snapshot',
        },
      },
    }
    const todoInfo: TqTaskStatusInfo = {
      ...completedInfo,
      status: 'todo',
      statusReason: null,
    }
    const warnSpy = vi.spyOn(logger, 'warn')
    warnSpy.mockClear()
    const expected = {
      content: {
        ...corruptContent,
        text: [
          '*🚨 CI failed*',
          'fohte/example · 起点の PR <https://github.com/fohte/example/pull/42|#42 Update database>',
          `未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
        ].join('\n'),
        color: '#d73a49',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*🚨 CI failed*' },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: 'fohte/example · 起点の PR <https://github.com/fohte/example/pull/42|#42 Update database>',
              },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
              },
            ],
          },
        ],
        metadata: {
          ...corruptContent.metadata,
          event_payload: {
            task_id: TASK.id,
            tq_task_status: 'todo',
            tq_task_status_reason: 'none',
            [TQ_ORIGINAL_CONTENT_KEY]: 'broken-snapshot',
          },
        },
      },
      warnings: [[{ task_id: TASK.id }, 'tq_original_content_decode_failed']],
    }

    const updateAndObserve = () => {
      const updated = updateTqTaskStatus(
        corruptContent,
        formatTqTaskStatus(todoInfo, TQ_WEB_URL),
        todoInfo,
      )
      return {
        content: normalizeTqOriginalContentSnapshot(updated),
        warnings: warnSpy.mock.calls,
      }
    }

    expect(updateAndObserve()).toEqual(expected)
  })

  it('updates task status in the previous compact layout when its snapshot is corrupt', () => {
    const status = `対応済み · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`
    const context =
      'fohte/example · 起点の PR <https://github.com/fohte/example/pull/42|#42 Update database>'
    const legacyContent: SlackMessageContent = {
      text: ['*✅ ~CI failed~*', context, status].join('\n'),
      color: '#2da44e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*✅ ~CI failed~*' },
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
          [TQ_ORIGINAL_CONTENT_KEY]: 'broken-snapshot',
        },
      },
    }
    const todoInfo: TqTaskStatusInfo = {
      ...completedInfo,
      status: 'todo',
      statusReason: null,
    }

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(
          legacyContent,
          formatTqTaskStatus(todoInfo, TQ_WEB_URL),
          todoInfo,
        ),
      ),
    ).toEqual({
      text: [
        '*🚨 CI failed*',
        context,
        `未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#d73a49',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*🚨 CI failed*' },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: context }],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `未対応 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
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
          [TQ_ORIGINAL_CONTENT_KEY]: 'broken-snapshot',
        },
      },
    })
  })

  it('keeps the full alert when the original-content snapshot exceeds Slack metadata size', () => {
    let state = 1
    const highEntropyText = Array.from({ length: 9000 }, () => {
      state = (state * 48_271) % 2_147_483_647
      return String.fromCharCode(33 + (state % 90))
    }).join('')
    const largeContent: SlackMessageContent = {
      text: '🚨 Large alert',
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 Large alert' },
        },
        {
          type: 'section',
          fields: Array.from({ length: 5 }, (_, index) => ({
            type: 'mrkdwn' as const,
            text: `*Field ${String(index)}*\n${highEntropyText.slice(index * 1800, (index + 1) * 1800)}`,
          })),
        },
      ],
      metadata: TASK_METADATA,
    }
    const status = formatTqTaskStatus(completedInfo, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(largeContent, status, completedInfo),
      ),
    ).toEqual({
      text: `🚨 Large alert\n${status}`,
      color: '#d73a49',
      blocks: [
        ...(largeContent.blocks ?? []),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `*状態*\n${status}` }],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'completed',
        },
      },
    })
  })

  it('keeps the task link in duplicate appearance when the duplicate target is unavailable', () => {
    const info: TqTaskStatusInfo = {
      ...completedInfo,
      statusReason: 'duplicate',
    }
    const status = formatTqTaskStatus(info, TQ_WEB_URL)

    expect(
      normalizeTqOriginalContentSnapshot(
        updateTqTaskStatus(sentryContent, status, info),
      ),
    ).toEqual({
      text: [
        '*🔁 ~Request failed~*',
        'api · <https://sentry.example.test/issue/7|View issue>',
        `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
      ].join('\n'),
      color: '#8b949e',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*🔁 ~Request failed~*' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'api · <https://sentry.example.test/issue/7|View issue>',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101>`,
            },
          ],
        },
      ],
      metadata: {
        event_type: 'alert_task',
        event_payload: {
          task_id: TASK.id,
          tq_task_status: 'completed',
          tq_task_status_reason: 'duplicate',
          [TQ_ORIGINAL_CONTENT_KEY]:
            expectedTqOriginalContentSnapshot(sentryContent),
        },
      },
    })
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

  it('reads a duplicate target title from metadata', () => {
    expect(
      readTqTaskStatusState({
        tq_task_status: 'completed',
        tq_task_status_reason: 'duplicate',
        tq_duplicate_task_id: 'task-target',
        tq_duplicate_task_number: 202,
        tq_duplicate_task_title: 'Review target',
      }),
    ).toEqual({
      status: 'completed',
      statusReason: 'duplicate',
      duplicateOfTask: {
        id: 'task-target',
        number: 202,
        title: 'Review target',
      },
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
      `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202> で対応`,
    )
  })

  it('escapes special characters in duplicate titles', () => {
    const info: TqTaskStatusInfo = {
      task: TASK,
      status: 'completed',
      statusReason: 'duplicate',
      duplicateOfTask: {
        id: 'task-target',
        number: 202,
        title: 'Review <target> & docs',
      },
    }

    expect(formatTqTaskStatus(info, TQ_WEB_URL)).toBe(
      `重複 · <${TQ_WEB_URL}/tasks/${TASK.id}|tq #101> → <${TQ_WEB_URL}/tasks/task-target|tq #202 Review &lt;target&gt; &amp; docs> で対応`,
    )
  })
})
