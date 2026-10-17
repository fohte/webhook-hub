import { describe, expect, it } from 'vitest'

import { setSourceAlertResolved } from '#plugins/tq/alert-source-appearance'
import {
  expectedTqOriginalContentSnapshot,
  normalizeTqOriginalContentSnapshot,
} from '#plugins/tq/alert-task-test-support'
import type { SlackMessageContent } from '#slack'

const TASK_METADATA = {
  event_type: 'alert_task',
  event_payload: { task_id: 'task-example-id' },
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

const TASK_ATTACHMENT = {
  text: '<https://tasks.example.test/tasks/task-example-id|tq #101> · todo',
  color: '#2eb67d',
  blocks: [
    {
      type: 'context' as const,
      elements: [
        {
          type: 'mrkdwn' as const,
          text: '<https://tasks.example.test/tasks/task-example-id|tq #101> · todo',
        },
      ],
    },
  ],
}

describe('setSourceAlertResolved', () => {
  it('folds only the source attachment and restores it from the snapshot', () => {
    const content: SlackMessageContent = {
      ...SOURCE_CONTENT,
      additionalAttachments: [TASK_ATTACHMENT],
      metadata: TASK_METADATA,
    }
    const resolved = setSourceAlertResolved(content, true)
    const restored = setSourceAlertResolved(resolved, false)

    expect(
      [resolved, restored].map(normalizeTqOriginalContentSnapshot),
    ).toEqual([
      {
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
        additionalAttachments: [TASK_ATTACHMENT],
        metadata: {
          event_type: 'alert_task',
          event_payload: {
            task_id: 'task-example-id',
            tq_original_content_v1:
              expectedTqOriginalContentSnapshot(SOURCE_CONTENT),
          },
        },
      },
      {
        ...SOURCE_CONTENT,
        additionalAttachments: [TASK_ATTACHMENT],
        metadata: TASK_METADATA,
      },
    ])
  })

  it('leaves source content unchanged when its snapshot exceeds Slack metadata size', () => {
    let state = 1
    const highEntropyText = Array.from({ length: 9000 }, () => {
      state = (state * 48_271) % 2_147_483_647
      return String.fromCharCode(33 + (state % 90))
    }).join('')
    const largeContent: SlackMessageContent = {
      ...SOURCE_CONTENT,
      blocks: [
        ...(SOURCE_CONTENT.blocks ?? []),
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

    expect(setSourceAlertResolved(largeContent, true)).toEqual(largeContent)
  })
})
