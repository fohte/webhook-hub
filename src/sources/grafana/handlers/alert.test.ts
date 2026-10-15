import { describe, expect, it } from 'vitest'

import { buildGrafanaAlertNotification } from '#sources/grafana/handlers/alert'

describe('buildGrafanaAlertNotification', () => {
  it('builds the Slack alert and tq task from one Grafana alert', () => {
    expect(
      buildGrafanaAlertNotification({
        status: 'firing',
        labels: {
          alertname: 'High CPU usage',
          severity: 'critical',
          instance: 'node-a',
        },
        annotations: {
          summary: 'CPU usage is high',
          description: 'Usage exceeded 90%',
          runbook_url: 'https://grafana.example.test/runbooks/cpu',
        },
        fingerprint: 'fp-abcdef',
        startsAt: '2026-01-01T00:00:00Z',
        generatorURL: 'https://grafana.example.test/alerting/rule-1',
        dashboardURL: 'https://grafana.example.test/d/board-1',
        panelURL: 'https://grafana.example.test/d/board-1?viewPanel=2',
      }),
    ).toEqual({
      alertName: 'High CPU usage',
      content: {
        text: '🚨 High CPU usage (発生中)',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🚨 High CPU usage' },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '*Severity*\ncritical' },
              { type: 'mrkdwn', text: '*instance*\nnode-a' },
            ],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*概要*\nCPU usage is high' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*説明*\nUsage exceeded 90%',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: [
                  '<https://grafana.example.test/d/board-1?viewPanel=2|Panel>',
                  '<https://grafana.example.test/d/board-1|Dashboard>',
                  '<https://grafana.example.test/alerting/rule-1|Rule>',
                  '<https://grafana.example.test/runbooks/cpu|Runbook>',
                ].join(' · '),
              },
            ],
          },
        ],
      },
      task: {
        title: 'Grafana alert: High CPU usage',
        description: [
          'Alert: High CPU usage',
          'Status: firing',
          'Started at: 2026-01-01T00:00:00Z',
          [
            'Labels:',
            '- alertname: High CPU usage',
            '- instance: node-a',
            '- severity: critical',
          ].join('\n'),
          [
            'Annotations:',
            '- description: Usage exceeded 90%',
            '- runbook_url: https://grafana.example.test/runbooks/cpu',
            '- summary: CPU usage is high',
          ].join('\n'),
          'Rule URL: https://grafana.example.test/alerting/rule-1',
          'Dashboard URL: https://grafana.example.test/d/board-1',
          'Panel URL: https://grafana.example.test/d/board-1?viewPanel=2',
        ].join('\n\n'),
        context: 'personal',
      },
      status: 'firing',
    })
  })

  it('keeps resolved alerts red while preserving the resolved title', () => {
    expect(
      buildGrafanaAlertNotification({
        status: 'resolved',
        labels: { alertname: 'Queue <full>' },
        annotations: { summary: 'Recovered & stable' },
        fingerprint: 'fp-recovered',
        startsAt: '2026-01-02T00:00:00Z',
      }),
    ).toEqual({
      alertName: 'Queue <full>',
      content: {
        text: '✅ Queue <full> (解決)',
        color: '#d73a49',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '✅ Queue <full>' },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*概要*\nRecovered &amp; stable' },
          },
        ],
      },
      task: {
        title: 'Grafana alert: Queue <full>',
        description: [
          'Alert: Queue <full>',
          'Status: resolved',
          'Started at: 2026-01-02T00:00:00Z',
          'Labels:\n- alertname: Queue <full>',
          'Annotations:\n- summary: Recovered & stable',
        ].join('\n\n'),
        context: 'personal',
      },
      status: 'resolved',
    })
  })
})
