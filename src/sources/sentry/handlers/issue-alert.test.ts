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

  it('uses empty app and culprit values when the event omits them', () => {
    const payload: SentryIssueAlertEvent = {
      action: 'triggered',
      data: {
        event: {
          title: 'TypeError: Cannot read properties of undefined',
          level: 'error',
          web_url: 'https://sentry.io/organizations/example-org/issues/123/',
          culprit: null,
        },
        triggered_rule: 'sample-rule',
      },
    }

    expect(extractIssueAlertInput(payload)).toEqual({
      action: 'triggered',
      app: '',
      culprit: '',
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
        text: '🐛 TypeError: Cannot read properties of undefined',
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
      task: {
        title: 'Sentry alert: TypeError: Cannot read properties of undefined',
        description: [
          'Application: sample-app',
          'Issue: TypeError: Cannot read properties of undefined',
          'Level: error',
          'Location: src/example.ts in runTask',
          'Rule: sample-rule',
          'Issue URL: https://sentry.io/organizations/example-org/issues/123/',
        ].join('\n'),
        context: 'personal',
      },
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      webUrl: 'https://sentry.io/organizations/example-org/issues/123/',
      triggeredRule: 'sample-rule',
    })
  })

  it('omits empty app and culprit fields', () => {
    expect(
      buildIssueAlertNotification(baseInput({ app: '', culprit: '' })),
    ).toEqual({
      content: {
        text: '🐛 TypeError: Cannot read properties of undefined',
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
              { type: 'mrkdwn', text: '*Level*\nerror' },
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
      task: {
        title: 'Sentry alert: TypeError: Cannot read properties of undefined',
        description: [
          'Application: Unknown',
          'Issue: TypeError: Cannot read properties of undefined',
          'Level: error',
          'Location: Unknown',
          'Rule: sample-rule',
          'Issue URL: https://sentry.io/organizations/example-org/issues/123/',
        ].join('\n'),
        context: 'personal',
      },
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      webUrl: 'https://sentry.io/organizations/example-org/issues/123/',
      triggeredRule: 'sample-rule',
    })
  })

  it('truncates a long title to fit a Slack header block', () => {
    const title = 'A'.repeat(160)
    const headerText = `🐛 ${'A'.repeat(146)}…`

    expect(buildIssueAlertNotification(baseInput({ title }))).toEqual({
      content: {
        text: `🐛 ${title}`,
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: headerText },
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
      task: {
        title: `Sentry alert: ${title}`,
        description: [
          'Application: sample-app',
          `Issue: ${title}`,
          'Level: error',
          'Location: src/example.ts in runTask',
          'Rule: sample-rule',
          'Issue URL: https://sentry.io/organizations/example-org/issues/123/',
        ].join('\n'),
        context: 'personal',
      },
      title,
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
        text: '🐛 Error: <script> & "quotes"',
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
      task: {
        title: 'Sentry alert: Error: <script> & "quotes"',
        description: [
          'Application: app<&',
          'Issue: Error: <script> & "quotes"',
          'Level: <b>error</b>',
          'Location: src/<script>.ts & runTask',
          'Rule: A & B',
          'Issue URL: https://sentry.io/organizations/example-org/issues/123/',
        ].join('\n'),
        context: 'personal',
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
