import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface GrafanaAlert {
  status: 'firing' | 'resolved'
  labels: Record<string, string>
  annotations: Record<string, string>
  fingerprint: string
  startsAt?: string
  endsAt?: string
  generatorURL?: string
  dashboardURL?: string
  panelURL?: string
}

export interface GrafanaAlertNotification {
  alertName: string
  content: SlackMessageContent
  task: CreateTaskRequest
  status: GrafanaAlert['status']
  fingerprint: string
}

const ALERT_COLORS = {
  firing: '#d73a49',
  resolved: '#2da44e',
} as const

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value

const escapeValue = (value: string, maxLength: number): string =>
  escapeSlackMrkdwn(truncate(value, maxLength))

const slackLink = (url: string | undefined, label: string): string | null => {
  if (url === undefined || !/^https?:\/\/[^\s<>|]+$/i.test(url)) return null
  return `<${escapeSlackMrkdwn(url)}|${escapeSlackMrkdwn(label)}>`
}

const renderAlertDetails = (alert: GrafanaAlert): SlackBlock[] => {
  const alertName = alert.labels['alertname'] ?? 'Grafana alert'
  const fields = [
    {
      type: 'mrkdwn' as const,
      text: `*状態*\n${alert.status === 'firing' ? '発生中' : '解決'}`,
    },
    ...(alert.labels['severity'] === undefined
      ? []
      : [
          {
            type: 'mrkdwn' as const,
            text: `*Severity*\n${escapeValue(alert.labels['severity'], 250)}`,
          },
        ]),
  ]

  const otherLabels = Object.entries(alert.labels)
    .filter(([key]) => key !== 'alertname' && key !== 'severity')
    .sort(([left], [right]) => left.localeCompare(right))
  const hasOtherLabels = otherLabels.length > 10 - fields.length
  const visibleLabels = otherLabels.slice(
    0,
    10 - fields.length - (hasOtherLabels ? 1 : 0),
  )
  fields.push(
    ...visibleLabels.map(([key, value]) => ({
      type: 'mrkdwn' as const,
      text: `*${escapeValue(key, 100)}*\n${escapeValue(value, 250)}`,
    })),
  )
  if (hasOtherLabels) {
    fields.push({
      type: 'mrkdwn' as const,
      text: `*その他のラベル*\n${String(otherLabels.length - visibleLabels.length)} 件`,
    })
  }

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncate(
          `${alert.status === 'firing' ? '🚨' : '✅'} ${alertName}`,
          150,
        ),
      },
    },
    { type: 'section', fields },
  ]

  for (const [key, label] of [
    ['summary', '概要'],
    ['description', '説明'],
  ] as const) {
    const value = alert.annotations[key]
    if (value !== undefined && value !== '') {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${label}*\n${escapeValue(value, 500)}`,
        },
      })
    }
  }

  const links = [
    slackLink(alert.panelURL, 'Panel'),
    slackLink(alert.dashboardURL, 'Dashboard'),
    slackLink(alert.generatorURL, 'Rule'),
    slackLink(alert.annotations['runbook_url'], 'Runbook'),
  ].filter((link) => link !== null)
  if (links.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: links.join(' · ') }],
    })
  }

  return blocks
}

const renderTaskDescription = (
  alert: GrafanaAlert,
  alertName: string,
): string => {
  const labels = Object.entries(alert.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `- ${key}: ${value}`)
  const annotations = Object.entries(alert.annotations)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `- ${key}: ${value}`)

  return [
    `Alert: ${alertName}`,
    `Status: ${alert.status}`,
    ...(alert.startsAt === undefined ? [] : [`Started at: ${alert.startsAt}`]),
    ...(alert.endsAt === undefined ? [] : [`Ended at: ${alert.endsAt}`]),
    ...(labels.length === 0 ? [] : [`Labels:\n${labels.join('\n')}`]),
    ...(annotations.length === 0
      ? []
      : [`Annotations:\n${annotations.join('\n')}`]),
    ...(alert.generatorURL === undefined
      ? []
      : [`Rule URL: ${alert.generatorURL}`]),
    ...(alert.dashboardURL === undefined
      ? []
      : [`Dashboard URL: ${alert.dashboardURL}`]),
    ...(alert.panelURL === undefined ? [] : [`Panel URL: ${alert.panelURL}`]),
  ].join('\n\n')
}

export const buildGrafanaAlertNotification = (
  alert: GrafanaAlert,
): GrafanaAlertNotification => {
  const alertName = alert.labels['alertname'] ?? 'Grafana alert'
  const statusLabel = alert.status === 'firing' ? '発生中' : '解決'
  const statusIcon = alert.status === 'firing' ? '🚨' : '✅'
  const content: SlackMessageContent = {
    text: `${statusIcon} ${alertName} (${statusLabel})`,
    color: ALERT_COLORS[alert.status],
    blocks: renderAlertDetails(alert),
  }

  return {
    alertName,
    content,
    task: {
      title: `Grafana alert: ${alertName}`,
      description: truncate(renderTaskDescription(alert, alertName), 10_000),
      context: 'personal',
    },
    status: alert.status,
    fingerprint: alert.fingerprint,
  }
}
