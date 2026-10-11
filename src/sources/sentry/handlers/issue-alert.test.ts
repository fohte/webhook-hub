import { describe, expect, it } from 'vitest'

import type {
  IssueAlertInput,
  SentryIssueAlertEvent,
} from '#sources/sentry/handlers/issue-alert'
import {
  buildIssueAlertNotification,
  extractIssueAlertInput,
} from '#sources/sentry/handlers/issue-alert'

const baseInput = (
  overrides: Partial<IssueAlertInput> = {},
): IssueAlertInput => ({
  action: 'triggered',
  app: 'sample-app',
  culprit: 'src/example.ts in runTask',
  title: 'TypeError: Cannot read properties of undefined',
  level: 'error',
  webUrl: 'https://sentry.io/organizations/example-org/issues/123/',
  triggeredRule: 'sample-rule',
  ...overrides,
})

describe('extractIssueAlertInput', () => {
  it('maps a Sentry issue alert payload to IssueAlertInput', () => {
    const payload: SentryIssueAlertEvent = {
      action: 'triggered',
      data: {
        event: {
          title: 'TypeError: Cannot read properties of undefined',
          level: 'error',
          web_url: 'https://sentry.io/organizations/example-org/issues/123/',
          url: 'https://sentry.io/api/0/projects/example-org/sample-app/events/456/',
          culprit: 'src/example.ts in runTask',
        },
        triggered_rule: 'sample-rule',
      },
    }

    expect(extractIssueAlertInput(payload)).toEqual({
      action: 'triggered',
      app: 'sample-app',
      culprit: 'src/example.ts in runTask',
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      webUrl: 'https://sentry.io/organizations/example-org/issues/123/',
      triggeredRule: 'sample-rule',
    })
  })
})

describe('buildIssueAlertNotification', () => {
  it('returns a notification for a triggered issue alert', () => {
    expect(buildIssueAlertNotification(baseInput())).toEqual({
      content: {
        text: [
          '🐛 TypeError: Cannot read properties of undefined',
          'アプリ: sample-app',
          'Level: error',
          '発生箇所: `src/example.ts in runTask`',
          'Rule: sample-rule',
          '<https://sentry.io/organizations/example-org/issues/123/|View issue>',
        ].join('\n'),
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '🐛 TypeError: Cannot read properties of undefined',
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '*アプリ*\nsample-app' },
              { type: 'mrkdwn', text: '*Level*\nerror' },
              {
                type: 'mrkdwn',
                text: '*発生箇所*\n`src/example.ts in runTask`',
              },
              { type: 'mrkdwn', text: '*Rule*\nsample-rule' },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://sentry.io/organizations/example-org/issues/123/|View issue>',
              },
            ],
          },
        ],
      },
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      webUrl: 'https://sentry.io/organizations/example-org/issues/123/',
      triggeredRule: 'sample-rule',
    })
  })

  it('escapes Slack mrkdwn metacharacters in title, level and triggered rule', () => {
    expect(
      buildIssueAlertNotification(
        baseInput({
          title: 'Error: <script> & "quotes"',
          app: 'app<&',
          culprit: 'src/<script>.ts & runTask',
          level: '<b>error</b>',
          triggeredRule: 'A & B',
        }),
      ),
    ).toEqual({
      content: {
        text: [
          '🐛 Error: &lt;script&gt; &amp; "quotes"',
          'アプリ: app&lt;&amp;',
          'Level: &lt;b&gt;error&lt;/b&gt;',
          '発生箇所: `src/&lt;script&gt;.ts &amp; runTask`',
          'Rule: A &amp; B',
          '<https://sentry.io/organizations/example-org/issues/123/|View issue>',
        ].join('\n'),
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🐛 Error: <script> & "quotes"' },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '*アプリ*\napp&lt;&amp;' },
              { type: 'mrkdwn', text: '*Level*\n&lt;b&gt;error&lt;/b&gt;' },
              {
                type: 'mrkdwn',
                text: '*発生箇所*\n`src/&lt;script&gt;.ts &amp; runTask`',
              },
              { type: 'mrkdwn', text: '*Rule*\nA &amp; B' },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://sentry.io/organizations/example-org/issues/123/|View issue>',
              },
            ],
          },
        ],
      },
      title: 'Error: <script> & "quotes"',
      level: '<b>error</b>',
      webUrl: 'https://sentry.io/organizations/example-org/issues/123/',
      triggeredRule: 'A & B',
    })
  })

  it('returns null when action is not triggered', () => {
    expect(
      buildIssueAlertNotification(baseInput({ action: 'resolved' })),
    ).toBeNull()
  })
})
