import { describe, expect, it } from 'vitest'

import type {
  IssueAlertInput,
  SentryIssueAlertEvent,
} from '#sources/sentry/handlers/issue-alert'
import {
  buildIssueAlertNotification,
  extractIssueAlertInput,
} from '#sources/sentry/handlers/issue-alert'

const ISSUE_TITLE = 'WidgetReadFault: catalog request failed'
const ISSUE_URL = 'https://monitoring.example.test/issues/456'
const EVENT_URL =
  'https://monitoring.example.test/api/0/projects/demo-team/widget-service/events/abc'

const baseInput = (
  overrides: Partial<IssueAlertInput> = {},
): IssueAlertInput => ({
  action: 'triggered',
  app: 'widget-service',
  culprit: 'src/widgets/read.ts in readWidget',
  title: ISSUE_TITLE,
  level: 'error',
  webUrl: ISSUE_URL,
  triggeredRule: 'widget failures',
  environment: 'staging',
  handled: 'handled',
  requestMethod: 'GET',
  requestUrl: '/api/widgets',
  causes: [
    'DataFetchFault: service response unavailable',
    'RemoteNodeFault: connection refused',
  ],
  stacktraceFrames: [
    {
      in_app: true,
      filename: 'src/widgets/read.ts',
      lineno: 23,
      context_line: 'return await client.get(path)',
    },
  ],
  ...overrides,
})

const issueAlertPayload = (): SentryIssueAlertEvent => ({
  action: 'triggered',
  data: {
    event: {
      title: ISSUE_TITLE,
      level: 'error',
      web_url: ISSUE_URL,
      url: EVENT_URL,
      culprit: 'src/widgets/read.ts in readWidget',
      request: {
        method: 'GET',
        url: 'https://api.example.test/api/widgets?limit=5',
      },
      tags: [
        { key: 'environment', value: 'staging' },
        { key: 'handled', value: 'yes' },
      ],
      exception: {
        values: [
          {
            type: 'RemoteNodeFault',
            value: 'connection refused',
          },
          {
            type: 'DataFetchFault',
            value: 'service response unavailable',
          },
          {
            type: 'WidgetReadFault',
            value: 'catalog request failed',
            stacktrace: {
              frames: [
                {
                  in_app: false,
                  filename: 'vendor/runtime.js',
                  lineno: 6,
                  context_line: 'raise error',
                },
                {
                  in_app: true,
                  filename: 'src/widgets/read.ts',
                  lineno: 23,
                  context_line: 'return await client.get(path)',
                },
                {
                  in_app: true,
                  filename: 'src/widgets/cache.ts',
                  lineno: 34,
                  context_line: 'const item = cache.get(key)',
                },
                {
                  in_app: true,
                  filename: 'src/widgets/client.ts',
                  lineno: 58,
                  context_line: 'return fetch(url)',
                },
                {
                  in_app: true,
                  filename: 'src/network/request.ts',
                  lineno: 91,
                  context_line: 'return transport(url)',
                },
                {
                  in_app: false,
                  filename: 'vendor/http.js',
                  lineno: 11,
                  context_line: 'throw error',
                },
              ],
            },
          },
        ],
      },
    },
    triggered_rule: 'widget failures',
  },
})

describe('extractIssueAlertInput', () => {
  it('extracts C3 details from the Sentry event alert payload', () => {
    expect(extractIssueAlertInput(issueAlertPayload())).toEqual({
      action: 'triggered',
      app: 'widget-service',
      culprit: 'src/widgets/read.ts in readWidget',
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
      environment: 'staging',
      handled: 'handled',
      requestMethod: 'GET',
      requestUrl: '/api/widgets',
      causes: [
        'DataFetchFault: service response unavailable',
        'RemoteNodeFault: connection refused',
      ],
      stacktraceFrames: [
        {
          in_app: true,
          filename: 'src/widgets/read.ts',
          lineno: 23,
          context_line: 'return await client.get(path)',
        },
        {
          in_app: true,
          filename: 'src/widgets/cache.ts',
          lineno: 34,
          context_line: 'const item = cache.get(key)',
        },
        {
          in_app: true,
          filename: 'src/widgets/client.ts',
          lineno: 58,
          context_line: 'return fetch(url)',
        },
        {
          in_app: true,
          filename: 'src/network/request.ts',
          lineno: 91,
          context_line: 'return transport(url)',
        },
      ],
    })
  })

  it('uses safe defaults when event details are missing', () => {
    expect(extractIssueAlertInput({ action: 'triggered' })).toEqual({
      action: 'triggered',
      app: '',
      culprit: '',
      title: 'Sentry issue alert',
      level: '',
      webUrl: '',
      triggeredRule: '',
      environment: '',
      handled: '',
      requestMethod: '',
      requestUrl: '',
      causes: [],
      stacktraceFrames: [],
    })
  })

  it('reads environment and handled tags when tags are string pairs', () => {
    expect(
      extractIssueAlertInput({
        action: 'triggered',
        data: {
          event: {
            tags: [
              ['environment', 'canary'],
              ['handled', 'no'],
            ],
          },
        },
      }),
    ).toEqual({
      action: 'triggered',
      app: '',
      culprit: '',
      title: 'Sentry issue alert',
      level: '',
      webUrl: '',
      triggeredRule: '',
      environment: 'canary',
      handled: 'unhandled',
      requestMethod: '',
      requestUrl: '',
      causes: [],
      stacktraceFrames: [],
    })
  })
})

describe('buildIssueAlertNotification', () => {
  it('renders the source attachment with the C3 details', () => {
    expect(
      buildIssueAlertNotification(
        baseInput({
          stacktraceFrames: [
            {
              in_app: true,
              filename: 'src/widgets/read.ts',
              lineno: 23,
              context_line: 'return await client.get(path)',
            },
            {
              in_app: false,
              filename: 'vendor/http.js',
              lineno: 11,
              context_line: 'throw error',
            },
            {
              in_app: true,
              filename: 'src/widgets/cache.ts',
              lineno: 34,
              context_line: 'const item = cache.get(key)',
            },
            {
              in_app: true,
              filename: 'src/widgets/client.ts',
              lineno: 58,
              context_line: 'return fetch(url)',
            },
            {
              in_app: true,
              filename: 'src/network/request.ts',
              lineno: 91,
              context_line: 'return transport(url)',
            },
          ],
        }),
      ),
    ).toEqual({
      content: {
        text: ISSUE_TITLE,
        color: '#d73a49',
        username: 'Sentry',
        iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: ISSUE_TITLE,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'widget-service · staging · handled · GET /api/widgets',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '原因: DataFetchFault: service response unavailable › RemoteNodeFault: connection refused',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                '`src/network/request.ts:91  return transport(url)`',
                '`src/widgets/client.ts:58  return fetch(url)`',
                '`src/widgets/cache.ts:34  const item = cache.get(key)`',
              ].join('\n'),
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://monitoring.example.test/issues/456|View issue>',
              },
            ],
          },
        ],
      },
      task: {
        title: `Sentry alert: ${ISSUE_TITLE}`,
        description: [
          'Application: widget-service',
          `Issue: ${ISSUE_TITLE}`,
          'Level: error',
          'Location: src/widgets/read.ts in readWidget',
          'Rule: widget failures',
          `Issue URL: ${ISSUE_URL}`,
        ].join('\n'),
        context: 'personal',
      },
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
    })
  })

  it('omits rows for absent optional details', () => {
    expect(
      buildIssueAlertNotification(
        baseInput({
          app: '',
          culprit: '',
          level: '',
          webUrl: '',
          triggeredRule: '',
          environment: '',
          handled: '',
          requestMethod: '',
          requestUrl: '',
          causes: [],
          stacktraceFrames: [],
        }),
      ),
    ).toEqual({
      content: {
        text: ISSUE_TITLE,
        color: '#d73a49',
        username: 'Sentry',
        iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: ISSUE_TITLE,
            },
          },
        ],
      },
      task: {
        title: `Sentry alert: ${ISSUE_TITLE}`,
        description: `Issue: ${ISSUE_TITLE}`,
        context: 'personal',
      },
      title: ISSUE_TITLE,
      level: '',
      webUrl: '',
      triggeredRule: '',
    })
  })

  it('truncates a long cause row to fit a Slack section block', () => {
    expect(
      buildIssueAlertNotification(baseInput({ causes: ['&'.repeat(1000)] })),
    ).toEqual({
      content: {
        text: ISSUE_TITLE,
        color: '#d73a49',
        username: 'Sentry',
        iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: ISSUE_TITLE },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'widget-service · staging · handled · GET /api/widgets',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `原因: ${'&amp;'.repeat(599)}…`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '`src/widgets/read.ts:23  return await client.get(path)`',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://monitoring.example.test/issues/456|View issue>',
              },
            ],
          },
        ],
      },
      task: {
        title: `Sentry alert: ${ISSUE_TITLE}`,
        description: [
          'Application: widget-service',
          `Issue: ${ISSUE_TITLE}`,
          'Level: error',
          'Location: src/widgets/read.ts in readWidget',
          'Rule: widget failures',
          `Issue URL: ${ISSUE_URL}`,
        ].join('\n'),
        context: 'personal',
      },
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
    })
  })

  it('truncates a long title to fit a Slack header block', () => {
    const title = 'WidgetReadFault '.repeat(12)
    const headerText = `${title.slice(0, 149)}…`

    expect(buildIssueAlertNotification(baseInput({ title }))).toEqual({
      content: {
        text: title,
        color: '#d73a49',
        username: 'Sentry',
        iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: headerText },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'widget-service · staging · handled · GET /api/widgets',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '原因: DataFetchFault: service response unavailable › RemoteNodeFault: connection refused',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '`src/widgets/read.ts:23  return await client.get(path)`',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://monitoring.example.test/issues/456|View issue>',
              },
            ],
          },
        ],
      },
      task: {
        title: `Sentry alert: ${title}`,
        description: [
          'Application: widget-service',
          `Issue: ${title}`,
          'Level: error',
          'Location: src/widgets/read.ts in readWidget',
          'Rule: widget failures',
          `Issue URL: ${ISSUE_URL}`,
        ].join('\n'),
        context: 'personal',
      },
      title,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
    })
  })

  it('escapes Slack mrkdwn characters in event details', () => {
    expect(
      buildIssueAlertNotification(
        baseInput({
          environment: 'stage<&',
          causes: ['WidgetFetchFault: value < 5 & retry'],
          stacktraceFrames: [
            {
              in_app: true,
              filename: 'src/widgets/read.ts',
              lineno: 23,
              context_line: 'return `item` < max && ready',
            },
          ],
        }),
      ),
    ).toEqual({
      content: {
        text: ISSUE_TITLE,
        color: '#d73a49',
        username: 'Sentry',
        iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: ISSUE_TITLE },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'widget-service · stage&lt;&amp; · handled · GET /api/widgets',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '原因: WidgetFetchFault: value &lt; 5 &amp; retry',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '`src/widgets/read.ts:23  return ˋitemˋ &lt; max &amp;&amp; ready`',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://monitoring.example.test/issues/456|View issue>',
              },
            ],
          },
        ],
      },
      task: {
        title: `Sentry alert: ${ISSUE_TITLE}`,
        description: [
          'Application: widget-service',
          `Issue: ${ISSUE_TITLE}`,
          'Level: error',
          'Location: src/widgets/read.ts in readWidget',
          'Rule: widget failures',
          `Issue URL: ${ISSUE_URL}`,
        ].join('\n'),
        context: 'personal',
      },
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
    })
  })

  it('returns null when action is not triggered', () => {
    expect(buildIssueAlertNotification(baseInput({ action: 'resolved' }))).toBe(
      null,
    )
  })
})
