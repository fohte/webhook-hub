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
          summary: 'The worker backlog crossed its target',
          description: 'Pending jobs exceeded the configured limit',
          runbook_url: 'https://grafana.example.test/runbooks/worker-backlog',
          Error:
            'failed to execute query [A]: { "error": { "code": 400, "message": "Invalid value" } }',
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
        text: 'Worker backlog rising\nThe worker backlog crossed its target',
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
              text: 'The worker backlog crossed its target',
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
          '```',
          'failed to execute query [A]: { "error": { "code": 400, "message": "Invalid value" } }',
          '```',
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
        startsAt: '2026-05-05T11:12:13Z',
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
          '- 開始: 2026-05-05 20:12 JST',
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
