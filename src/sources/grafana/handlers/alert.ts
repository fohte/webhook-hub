import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { TODO_ALERT_COLOR } from '#sources/alert-colors'

const GRAFANA_USERNAME = 'Grafana'
const GRAFANA_ICON_URL = 'https://grafana.com/static/assets/img/fav32.png'

export interface GrafanaAlert {
  status: 'firing' | 'resolved'
  labels: Record<string, string>
  annotations: Record<string, string>
  fingerprint: string
  startsAt: string
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
}

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value

const slackLink = (url: string | undefined, label: string): string | null => {
  if (url === undefined || !/^https?:\/\/[^\s<>|]+$/i.test(url)) return null
  return `<${escapeSlackMrkdwn(url)}|${escapeSlackMrkdwn(label)}>`
}

const renderAlertDetails = (
  alertName: string,
  summary: string | undefined,
  panelURL: string | undefined,
): SlackBlock[] => {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncate(alertName, 150),
      },
    },
  ]

  if (summary !== undefined) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: escapeSlackMrkdwn(summary) },
    })
  }

  const panelLink = slackLink(panelURL, 'Panel')
  if (panelLink !== null) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: panelLink }],
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
    `Started at: ${alert.startsAt}`,
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
  const rawSummary = alert.annotations['summary']
  const summary =
    rawSummary === undefined || rawSummary === ''
      ? undefined
      : truncate(rawSummary, 500)
  const content: SlackMessageContent = {
    text: [alertName, ...(summary === undefined ? [] : [summary])].join('\n'),
    color: TODO_ALERT_COLOR,
    blocks: renderAlertDetails(alertName, summary, alert.panelURL),
    username: GRAFANA_USERNAME,
    iconUrl: GRAFANA_ICON_URL,
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
  }
}
