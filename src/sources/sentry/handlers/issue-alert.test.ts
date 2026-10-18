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

const MISSING_DETAILS_TASK_DESCRIPTION = [
  '## なぜやるか',
  '',
  `Sentry で \`${ISSUE_TITLE}\` が発生している。`,
  '',
  '## やること',
  '',
  '発生箇所の原因を調べて直す。',
  '',
  '## 完了条件',
  '',
  '- [ ] Sentry の issue が resolved になる',
].join('\n')

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
            stacktrace: {
              frames: [
                {
                  in_app: true,
                  filename: 'src/network/legacy.ts',
                  lineno: 4,
                  context_line: 'return openConnection()',
                },
              ],
            },
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

  it('falls back to cause frames when the primary exception has no in-app frames', () => {
    expect(
      extractIssueAlertInput({
        action: 'triggered',
        data: {
          event: {
            exception: {
              values: [
                {
                  type: 'OlderFault',
                  value: 'connection unavailable',
                  stacktrace: {
                    frames: [
                      {
                        in_app: true,
                        filename: 'src/widgets/cause.ts',
                        lineno: 12,
                        context_line: 'return connect()',
                      },
                    ],
                  },
                },
                {
                  type: 'WidgetFault',
                  value: 'request failed',
                  stacktrace: {
                    frames: [
                      {
                        in_app: false,
                        filename: 'vendor/runtime.js',
                        lineno: 31,
                        context_line: 'throw error',
                      },
                    ],
                  },
                },
              ],
            },
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
      environment: '',
      handled: '',
      requestMethod: '',
      requestUrl: '',
      causes: ['OlderFault: connection unavailable'],
      stacktraceFrames: [
        {
          in_app: true,
          filename: 'src/widgets/cause.ts',
          lineno: 12,
          context_line: 'return connect()',
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
              text: '`widget-service` · staging · handled · `GET /api/widgets`',
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
                '```',
                'src/network/request.ts:91  return transport(url)',
                'src/widgets/client.ts:58  return fetch(url)',
                'src/widgets/cache.ts:34  const item = cache.get(key)',
                '```',
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
        title: `widget-service: ${ISSUE_TITLE}`,
        description: [
          '## なぜやるか',
          '',
          `widget-service で \`${ISSUE_TITLE}\` が発生している。`,
          '',
          '- Level: `error`',
          '- Rule: `widget failures`',
          '',
          '## やること',
          '',
          '発生箇所の原因を調べて直す。',
          '',
          '- 発生箇所: `src/widgets/read.ts in readWidget`',
          '- Environment: `staging`',
          '- Handled: `handled`',
          '- Request: `GET /api/widgets`',
          '- Causes:',
          '  - `DataFetchFault: service response unavailable`',
          '  - `RemoteNodeFault: connection refused`',
          '- Stacktrace:',
          '  ```',
          '  src/network/request.ts:91  return transport(url)',
          '  src/widgets/client.ts:58  return fetch(url)',
          '  src/widgets/cache.ts:34  const item = cache.get(key)',
          '  ```',
          `- Issue: ${ISSUE_URL}`,
          '',
          '## 完了条件',
          '',
          '- [ ] Sentry の issue が resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/sentry', 'dev/widget-service'],
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
        title: `Sentry: ${ISSUE_TITLE}`,
        description: MISSING_DETAILS_TASK_DESCRIPTION,
        context: 'personal',
        labels: ['alert/sentry'],
      },
      title: ISSUE_TITLE,
      level: '',
      webUrl: '',
      triggeredRule: '',
    })
  })

  it('truncates a long cause row to fit a Slack section block', () => {
    expect(
      buildIssueAlertNotification(
        baseInput({
          causes: [
            '&'.repeat(1000),
            'SecondFault: retry failed',
            'ThirdFault: connection closed',
            'FourthFault: timeout',
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
              text: '`widget-service` · staging · handled · `GET /api/widgets`',
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
              text: [
                '```',
                'src/widgets/read.ts:23  return await client.get(path)',
                '```',
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
        title: `widget-service: ${ISSUE_TITLE}`,
        description: [
          '## なぜやるか',
          '',
          `widget-service で \`${ISSUE_TITLE}\` が発生している。`,
          '',
          '- Level: `error`',
          '- Rule: `widget failures`',
          '',
          '## やること',
          '',
          '発生箇所の原因を調べて直す。',
          '',
          '- 発生箇所: `src/widgets/read.ts in readWidget`',
          '- Environment: `staging`',
          '- Handled: `handled`',
          '- Request: `GET /api/widgets`',
          '- Causes:',
          `  - \`${'&'.repeat(699)}…\``,
          '  - `SecondFault: retry failed`',
          '  - `ThirdFault: connection closed`',
          '  - `FourthFault: timeout`',
          '- Stacktrace:',
          '  ```',
          '  src/widgets/read.ts:23  return await client.get(path)',
          '  ```',
          `- Issue: ${ISSUE_URL}`,
          '',
          '## 完了条件',
          '',
          '- [ ] Sentry の issue が resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/sentry', 'dev/widget-service'],
      },
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
    })
  })

  it('caps the context row while keeping app and request in inline code', () => {
    const app = 'a'.repeat(1000)
    const environment = 'e'.repeat(1000)
    const handled = 'h'.repeat(1000)
    const requestUrl = `/${'p'.repeat(1000)}`

    expect(
      buildIssueAlertNotification(
        baseInput({
          app,
          environment,
          handled,
          requestMethod: 'GET',
          requestUrl,
          causes: [],
          stacktraceFrames: [],
          webUrl: '',
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
              text: [
                `\`${'a'.repeat(699)}…\``,
                `${'e'.repeat(699)}…`,
                `${'h'.repeat(699)}…`,
                `\`GET /${'p'.repeat(694)}…\``,
              ].join(' · '),
            },
          },
        ],
      },
      task: {
        title: `${app}: ${ISSUE_TITLE}`,
        description: [
          '## なぜやるか',
          '',
          `${app} で \`${ISSUE_TITLE}\` が発生している。`,
          '',
          '- Level: `error`',
          '- Rule: `widget failures`',
          '',
          '## やること',
          '',
          '発生箇所の原因を調べて直す。',
          '',
          '- 発生箇所: `src/widgets/read.ts in readWidget`',
          `- Environment: \`${'e'.repeat(699)}…\``,
          `- Handled: \`${'h'.repeat(699)}…\``,
          `- Request: \`GET /${'p'.repeat(694)}…\``,
          '',
          '## 完了条件',
          '',
          '- [ ] Sentry の issue が resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/sentry', `dev/${app}`],
      },
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: '',
      triggeredRule: 'widget failures',
    })
  })

  it('truncates long stack frames inside one bounded code block', () => {
    const contextLine = `      ${'x'.repeat(2000)}`
    const frameLine = (filename: string, lineno: number): string => {
      const prefix = `${filename}:${String(lineno)}  `
      return `${prefix}${'x'.repeat(996 - prefix.length - 1)}…`
    }

    expect(
      buildIssueAlertNotification(
        baseInput({
          app: '',
          environment: '',
          handled: '',
          requestMethod: '',
          requestUrl: '',
          causes: [],
          stacktraceFrames: [
            {
              in_app: true,
              filename: 'src/widgets/old.ts',
              lineno: 5,
              context_line: contextLine,
            },
            {
              in_app: true,
              filename: 'src/widgets/mid.ts',
              lineno: 8,
              context_line: contextLine,
            },
            {
              in_app: true,
              filename: 'src/widgets/new.ts',
              lineno: 13,
              context_line: contextLine,
            },
          ],
          webUrl: '',
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
              text: [
                '```',
                frameLine('src/widgets/new.ts', 13),
                frameLine('src/widgets/mid.ts', 8),
                frameLine('src/widgets/old.ts', 5),
                '```',
              ].join('\n'),
            },
          },
        ],
      },
      task: {
        title: `Sentry: ${ISSUE_TITLE}`,
        description: [
          '## なぜやるか',
          '',
          `Sentry で \`${ISSUE_TITLE}\` が発生している。`,
          '',
          '- Level: `error`',
          '- Rule: `widget failures`',
          '',
          '## やること',
          '',
          '発生箇所の原因を調べて直す。',
          '',
          '- 発生箇所: `src/widgets/read.ts in readWidget`',
          '- Stacktrace:',
          '  ```',
          `  ${frameLine('src/widgets/new.ts', 13)}`,
          `  ${frameLine('src/widgets/mid.ts', 8)}`,
          `  ${frameLine('src/widgets/old.ts', 5)}`,
          '  ```',
          '',
          '## 完了条件',
          '',
          '- [ ] Sentry の issue が resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/sentry'],
      },
      title: ISSUE_TITLE,
      level: 'error',
      webUrl: '',
      triggeredRule: 'widget failures',
    })
  })

  it('truncates a long title in the Slack header and task description', () => {
    const title = 'WidgetReadFault '.repeat(50)
    const headerText = `${title.slice(0, 149)}…`
    const taskDescriptionTitle = `${title.slice(0, 699)}…`

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
              text: '`widget-service` · staging · handled · `GET /api/widgets`',
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
                '```',
                'src/widgets/read.ts:23  return await client.get(path)',
                '```',
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
        title: `widget-service: ${title.trim()}`,
        description: [
          '## なぜやるか',
          '',
          `widget-service で \`${taskDescriptionTitle}\` が発生している。`,
          '',
          '- Level: `error`',
          '- Rule: `widget failures`',
          '',
          '## やること',
          '',
          '発生箇所の原因を調べて直す。',
          '',
          '- 発生箇所: `src/widgets/read.ts in readWidget`',
          '- Environment: `staging`',
          '- Handled: `handled`',
          '- Request: `GET /api/widgets`',
          '- Causes:',
          '  - `DataFetchFault: service response unavailable`',
          '  - `RemoteNodeFault: connection refused`',
          '- Stacktrace:',
          '  ```',
          '  src/widgets/read.ts:23  return await client.get(path)',
          '  ```',
          `- Issue: ${ISSUE_URL}`,
          '',
          '## 完了条件',
          '',
          '- [ ] Sentry の issue が resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/sentry', 'dev/widget-service'],
      },
      title,
      level: 'error',
      webUrl: ISSUE_URL,
      triggeredRule: 'widget failures',
    })
  })

  it('renders event details with safe Slack and task Markdown delimiters', () => {
    const title = '`WidgetReadFault`\nretrying`'
    const taskTitle = 'widget-service: `WidgetReadFault` retrying`'
    expect(
      buildIssueAlertNotification(
        baseInput({
          title,
          level: 'error\ncritical',
          triggeredRule: '\n# high priority alert',
          culprit: 'src/widgets/readWidget\nin readWidget`',
          environment: 'stage<&',
          causes: [
            'WidgetFetchFault: value < 5 & retry',
            '`RemoteNodeFault`\nconnection refused',
          ],
          stacktraceFrames: [
            {
              in_app: true,
              filename: 'src/widgets/```read```.ts',
              lineno: 23,
              context_line: 'return ```item``` < max\n && ready',
            },
          ],
        }),
      ),
    ).toEqual({
      content: {
        text: title,
        color: '#d73a49',
        username: 'Sentry',
        iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: title },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '`widget-service` · stage&lt;&amp; · handled · `GET /api/widgets`',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '原因: WidgetFetchFault: value &lt; 5 &amp; retry › `RemoteNodeFault`\nconnection refused',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                '```',
                'src/widgets/ˋˋˋreadˋˋˋ.ts:23  return ˋˋˋitemˋˋˋ &lt; max &amp;&amp; ready',
                '```',
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
        title: taskTitle,
        description: [
          '## なぜやるか',
          '',
          'widget-service で `` `WidgetReadFault` retrying` `` が発生している。',
          '',
          '- Level: `error critical`',
          '- Rule: `# high priority alert`',
          '',
          '## やること',
          '',
          '発生箇所の原因を調べて直す。',
          '',
          '- 発生箇所: `` src/widgets/readWidget in readWidget` ``',
          '- Environment: `stage<&`',
          '- Handled: `handled`',
          '- Request: `GET /api/widgets`',
          '- Causes:',
          '  - `WidgetFetchFault: value < 5 & retry`',
          '  - `` `RemoteNodeFault` connection refused ``',
          '- Stacktrace:',
          '  ````',
          '  src/widgets/```read```.ts:23  return ```item``` < max && ready',
          '  ````',
          `- Issue: ${ISSUE_URL}`,
          '',
          '## 完了条件',
          '',
          '- [ ] Sentry の issue が resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/sentry', 'dev/widget-service'],
      },
      title,
      level: 'error\ncritical',
      webUrl: ISSUE_URL,
      triggeredRule: '\n# high priority alert',
    })
  })

  it('returns null when action is not triggered', () => {
    expect(buildIssueAlertNotification(baseInput({ action: 'resolved' }))).toBe(
      null,
    )
  })
})
