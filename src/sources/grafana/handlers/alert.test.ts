import { describe, expect, it } from 'vitest'

import type { SlackBlock } from '#slack'
import {
  buildGrafanaAlertNotification,
  isGrafanaPanelLinkBlock,
} from '#sources/grafana/handlers/alert'

describe('buildGrafanaAlertNotification', () => {
  it('identifies only the Grafana Panel link context block', () => {
    const contextBlocks: SlackBlock[] = [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '<https://observability.example.test/d/overview|Dashboard>',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '<https://observability.example.test/d/overview?viewPanel=7|Panel>',
          },
        ],
      },
    ]
    const results = contextBlocks.map(isGrafanaPanelLinkBlock)

    expect(results).toEqual([false, true])
  })

  it('builds the compact Grafana body and preserves full task details', () => {
    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: {
          alertname: 'Worker backlog rising',
          severity: 'warning',
          environment: 'staging',
          grafana_folder: 'operations',
        },
        annotations: {
          summary: 'The worker backlog\ncrossed its target',
          description: 'Pending jobs exceeded the configured limit',
          runbook_url: 'https://grafana.example.test/runbooks/worker-backlog',
          Error:
            'failed to execute query [A]: { "error": { "code": 400, "message": "Invalid ```value```" } }',
          grafana_state_reason: 'Updated',
        },
        fingerprint: 'fp-worker-backlog',
        startsAt: '2026-05-04T10:11:12Z',
        generatorURL: 'https://grafana.example.test/alerting/rule-9',
        dashboardURL: 'https://grafana.example.test/d/worker-health',
        panelURL: 'https://grafana.example.test/d/worker-health?viewPanel=8',
      }),
    ).toEqual({
      alertName: 'Worker backlog rising',
      content: {
        text: 'Worker backlog rising\nThe worker backlog\ncrossed its target',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Worker backlog rising' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'The worker backlog\ncrossed its target',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://grafana.example.test/d/worker-health?viewPanel=8|Panel>',
              },
            ],
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title: 'The worker backlog crossed its target',
        description: [
          '## なぜやるか',
          '',
          'The worker backlog crossed its target',
          '',
          '- 開始: 2026-05-04 19:11 JST',
          '- environment: staging',
          '- severity: warning',
          '- runbook_url: https://grafana.example.test/runbooks/worker-backlog',
          '',
          '⚠ ルールのクエリが失敗している',
          '',
          '````',
          'failed to execute query [A]: { "error": { "code": 400, "message": "Invalid ```value```" } }',
          '````',
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '- Panel: https://grafana.example.test/d/worker-health?viewPanel=8',
          '- Rule: https://grafana.example.test/alerting/rule-9',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'firing',
    })
  })

  it('normalizes the alertname fallback when the summary is missing', () => {
    const alertName =
      'Queue pressure\n## Unexpected heading\n- [ ] Unexpected checklist'

    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: { alertname: alertName },
        annotations: {},
        fingerprint: 'fp-queue-pressure',
        startsAt: '2026-01-01T00:00:00Z',
      }),
    ).toEqual({
      alertName,
      content: {
        text: alertName,
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: alertName },
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title:
          'Queue pressure ## Unexpected heading - [ ] Unexpected checklist',
        description: [
          '## なぜやるか',
          '',
          'Queue pressure ## Unexpected heading - [ ] Unexpected checklist',
          '',
          '- 開始: 2026-01-01 09:00 JST',
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'firing',
    })
  })

  it('keeps required sections when the query error is long', () => {
    const error = 'x'.repeat(4_001)

    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: { alertname: 'Query evaluation failed' },
        annotations: { Error: error },
        fingerprint: 'fp-query-failure',
        startsAt: '2026-05-06T00:00:00Z',
      }),
    ).toEqual({
      alertName: 'Query evaluation failed',
      content: {
        text: 'Query evaluation failed',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Query evaluation failed' },
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title: 'Query evaluation failed',
        description: [
          '## なぜやるか',
          '',
          'Query evaluation failed',
          '',
          '- 開始: 2026-05-06 09:00 JST',
          '',
          '⚠ ルールのクエリが失敗している',
          '',
          '```',
          `${'x'.repeat(3_999)}…`,
          '```',
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'firing',
    })
  })

  it('keeps required sections and URLs when alert metadata values are large', () => {
    const largeValue = 'v'.repeat(20_000)
    const truncatedValue = `${'v'.repeat(499)}…`

    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: {
          alertname: 'Queue depth',
          service: largeValue,
        },
        annotations: {
          summary: 'Queue is growing',
          runbook: largeValue,
        },
        fingerprint: 'fp-queue-depth',
        startsAt: '2026-01-01T00:00:00Z',
        generatorURL: 'https://grafana.example.test/alerting/rule-4',
        panelURL: 'https://grafana.example.test/d/queue?viewPanel=4',
      }),
    ).toEqual({
      alertName: 'Queue depth',
      content: {
        text: 'Queue depth\nQueue is growing',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Queue depth' },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Queue is growing' },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://grafana.example.test/d/queue?viewPanel=4|Panel>',
              },
            ],
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title: 'Queue is growing',
        description: [
          '## なぜやるか',
          '',
          'Queue is growing',
          '',
          '- 開始: 2026-01-01 09:00 JST',
          `- service: ${truncatedValue}`,
          `- runbook: ${truncatedValue}`,
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '- Panel: https://grafana.example.test/d/queue?viewPanel=4',
          '- Rule: https://grafana.example.test/alerting/rule-4',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'firing',
    })
  })

  it('keeps required sections and URLs when the aggregate metadata exceeds its limit', () => {
    const largeValue = 'v'.repeat(20_000)
    const truncatedValue = `${'v'.repeat(499)}…`
    const labels = Object.fromEntries(
      ['label-a', 'label-b', 'label-c', 'label-d', 'label-e'].map((key) => [
        key,
        largeValue,
      ]),
    )
    const annotations = Object.fromEntries([
      ['annotation-a', largeValue],
      ['annotation-b', largeValue],
      ['annotation-c', largeValue],
      ['annotation-d', largeValue],
      ['annotation-e', largeValue],
      ['summary', 'Queue is growing'],
    ])

    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: { ...labels, alertname: 'Queue depth' },
        annotations,
        fingerprint: 'fp-queue-depth',
        startsAt: '2026-01-01T00:00:00Z',
        generatorURL: 'https://grafana.example.test/alerting/rule-4',
        panelURL: 'https://grafana.example.test/d/queue?viewPanel=4',
      }),
    ).toEqual({
      alertName: 'Queue depth',
      content: {
        text: 'Queue depth\nQueue is growing',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Queue depth' },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Queue is growing' },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '<https://grafana.example.test/d/queue?viewPanel=4|Panel>',
              },
            ],
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title: 'Queue is growing',
        description: [
          '## なぜやるか',
          '',
          'Queue is growing',
          '',
          '- 開始: 2026-01-01 09:00 JST',
          `- label-a: ${truncatedValue}`,
          `- label-b: ${truncatedValue}`,
          `- label-c: ${truncatedValue}`,
          `- label-d: ${truncatedValue}`,
          `- label-e: ${truncatedValue}`,
          `- annotation-a: ${truncatedValue}`,
          `- annotation-b: ${truncatedValue}`,
          '- 残り 3 件の label / annotation を省略',
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '- Panel: https://grafana.example.test/d/queue?viewPanel=4',
          '- Rule: https://grafana.example.test/alerting/rule-4',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'firing',
    })
  })

  it('normalizes label and annotation values to one line', () => {
    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: {
          alertname: 'Queue depth',
          service: 'worker\n## Unexpected heading',
        },
        annotations: {
          summary: 'Queue is growing',
          runbook:
            'https://grafana.example.test/runbook\n- [ ] Unexpected task',
        },
        fingerprint: 'fp-queue-depth',
        startsAt: '2026-01-01T00:00:00Z',
      }),
    ).toEqual({
      alertName: 'Queue depth',
      content: {
        text: 'Queue depth\nQueue is growing',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Queue depth' },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Queue is growing' },
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title: 'Queue is growing',
        description: [
          '## なぜやるか',
          '',
          'Queue is growing',
          '',
          '- 開始: 2026-01-01 09:00 JST',
          '- service: worker ## Unexpected heading',
          '- runbook: https://grafana.example.test/runbook - [ ] Unexpected task',
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'firing',
    })
  })

  it('builds the same compact body for resolved alerts before dispatch folding', () => {
    expect(
      buildGrafanaAlertNotification({
        status: 'resolved',
        labels: {
          alertname: 'Message queue pressure',
          grafana_folder: 'operations',
        },
        annotations: {
          description: 'The queue has returned below the limit',
          grafana_state_reason: 'NoData',
        },
        fingerprint: 'fp-message-queue',
        startsAt: 'invalid timestamp',
      }),
    ).toEqual({
      alertName: 'Message queue pressure',
      content: {
        text: 'Message queue pressure',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: 'Message queue pressure' },
          },
        ],
        username: 'Grafana',
        iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
      },
      task: {
        title: 'Message queue pressure',
        description: [
          '## なぜやるか',
          '',
          'Message queue pressure',
          '',
          '- 開始: invalid timestamp',
          '',
          '## やること',
          '',
          'グラフで状況を確かめ、原因を取り除く。',
          '',
          '## 完了条件',
          '',
          '- [ ] アラートが resolved になる',
        ].join('\n'),
        context: 'personal',
        labels: ['alert/grafana'],
      },
      status: 'resolved',
    })
  })
})
