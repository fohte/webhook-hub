import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { TODO_ALERT_COLOR } from '#sources/alert-colors'

const GRAFANA_USERNAME = 'Grafana'
const GRAFANA_ICON_URL = 'https://grafana.com/static/assets/img/fav32.png'
const PANEL_LINK_LABEL = 'Panel'

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

const formatStartedAt = (startsAt: string): string => {
  const jstDate = new Date(Date.parse(startsAt) + 9 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const year = String(jstDate.getUTCFullYear()).padStart(4, '0')
  const month = pad(jstDate.getUTCMonth() + 1)
  const day = pad(jstDate.getUTCDate())
  const hours = pad(jstDate.getUTCHours())
  const minutes = pad(jstDate.getUTCMinutes())
  return `${year}-${month}-${day} ${hours}:${minutes} JST`
}

const renderCodeBlock = (value: string): string => {
  const longestBacktickRun = (value.match(/`+/gu) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    2,
  )
  const fence = '`'.repeat(longestBacktickRun + 1)
  return `${fence}\n${value}\n${fence}`
}

const slackLink = (url: string | undefined, label: string): string | null => {
  if (url === undefined || !/^https?:\/\/[^\s<>|]+$/i.test(url)) return null
  return `<${escapeSlackMrkdwn(url)}|${escapeSlackMrkdwn(label)}>`
}

export const isGrafanaPanelLinkBlock = (block: SlackBlock): boolean =>
  block.type === 'context' &&
  block.elements.some(
    (element) =>
      'text' in element &&
      typeof element.text === 'string' &&
      element.text.endsWith(`|${PANEL_LINK_LABEL}>`),
  )

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

  const panelLink = slackLink(panelURL, PANEL_LINK_LABEL)
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
    .filter(([key]) => key !== 'alertname' && !key.startsWith('grafana_'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `- ${key}: ${value}`)
  const annotations = Object.entries(alert.annotations)
    .filter(
      ([key]) =>
        key !== 'summary' &&
        key !== 'description' &&
        key !== 'Error' &&
        !key.startsWith('grafana_'),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `- ${key}: ${value}`)
  const error = alert.annotations['Error']
  const details = [
    `- 開始: ${formatStartedAt(alert.startsAt)}`,
    ...labels,
    ...annotations,
  ]
  const errorBlock =
    error === undefined || error === ''
      ? []
      : ['⚠ ルールのクエリが失敗している', renderCodeBlock(error)]
  const actionDetails = [
    ...(alert.panelURL === undefined ? [] : [`- Panel: ${alert.panelURL}`]),
    ...(alert.generatorURL === undefined
      ? []
      : [`- Rule: ${alert.generatorURL}`]),
  ]

  const whySection = [
    '## なぜやるか',
    '',
    alert.annotations['summary'] === undefined ||
    alert.annotations['summary'] === ''
      ? alertName
      : alert.annotations['summary'],
    '',
    details.join('\n'),
  ].join('\n')
  const actionSection = [
    '## やること',
    '',
    'グラフで状況を確かめ、原因を取り除く。',
    ...(actionDetails.length === 0 ? [] : ['', ...actionDetails]),
  ].join('\n')
  const completionSection = [
    '## 完了条件',
    '',
    '- [ ] アラートが resolved になる',
  ].join('\n')

  return [
    whySection,
    ...(errorBlock.length === 0 ? [] : [errorBlock.join('\n\n')]),
    actionSection,
    completionSection,
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
      title:
        rawSummary === undefined || rawSummary === '' ? alertName : rawSummary,
      description: truncate(renderTaskDescription(alert, alertName), 10_000),
      context: 'personal',
      labels: ['alert/grafana'],
    },
    status: alert.status,
  }
}
