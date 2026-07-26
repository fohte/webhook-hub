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
  title: 'TypeError: Cannot read properties of undefined',
  level: 'error',
  webUrl: 'https://sentry.io/organizations/fohte/issues/1/',
  triggeredRule: 'Production errors',
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
          web_url: 'https://sentry.io/organizations/fohte/issues/1/',
        },
        triggered_rule: 'Production errors',
      },
    }

    expect(extractIssueAlertInput(payload)).toEqual({
      action: 'triggered',
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      webUrl: 'https://sentry.io/organizations/fohte/issues/1/',
      triggeredRule: 'Production errors',
    })
  })
})

describe('buildIssueAlertNotification', () => {
  it('returns a notification for a triggered issue alert', () => {
    expect(buildIssueAlertNotification(baseInput())).toEqual({
      text: [
        ':rotating_light: *Sentry alert: TypeError: Cannot read properties of undefined*',
        'Level: *error* / Rule: *Production errors*',
        '<https://sentry.io/organizations/fohte/issues/1/|View issue>',
      ].join('\n'),
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      webUrl: 'https://sentry.io/organizations/fohte/issues/1/',
      triggeredRule: 'Production errors',
    })
  })

  it('escapes Slack mrkdwn metacharacters in title, level and triggered rule', () => {
    expect(
      buildIssueAlertNotification(
        baseInput({
          title: 'Error: <script> & "quotes"',
          level: '<b>error</b>',
          triggeredRule: 'A & B',
        }),
      ),
    ).toEqual({
      text: [
        ':rotating_light: *Sentry alert: Error: &lt;script&gt; &amp; "quotes"*',
        'Level: *&lt;b&gt;error&lt;/b&gt;* / Rule: *A &amp; B*',
        '<https://sentry.io/organizations/fohte/issues/1/|View issue>',
      ].join('\n'),
      title: 'Error: <script> & "quotes"',
      level: '<b>error</b>',
      webUrl: 'https://sentry.io/organizations/fohte/issues/1/',
      triggeredRule: 'A & B',
    })
  })

  it('returns null when action is not triggered', () => {
    expect(
      buildIssueAlertNotification(baseInput({ action: 'resolved' })),
    ).toBeNull()
  })
})
