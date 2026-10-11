import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface SentryIssueAlertEvent {
  action: string
  data: {
    event: {
      title: string
      level: string
      web_url: string
      url: string
      culprit: string
    }
    triggered_rule: string
  }
}

export interface IssueAlertInput {
  action: string
  app: string
  culprit: string
  title: string
  level: string
  webUrl: string
  triggeredRule: string
}

export interface IssueAlertNotification {
  content: SlackMessageContent
  title: string
  level: string
  webUrl: string
  triggeredRule: string
}

const SENTRY_ALERT_COLOR = '#d73a49'
const HEADER_TEXT_MAX_LENGTH = 150

const extractProjectSlug = (eventUrl: string): string =>
  eventUrl.split('/projects/')[1]?.split('/')[1] ?? ''

const truncateHeaderText = (text: string): string =>
  text.length > HEADER_TEXT_MAX_LENGTH
    ? `${text.slice(0, HEADER_TEXT_MAX_LENGTH - 1)}…`
    : text

const buildField = (label: string, value: string, asCode = false): string =>
  `*${label}*\n${asCode ? `\`${escapeSlackMrkdwn(value)}\`` : escapeSlackMrkdwn(value)}`

export const extractIssueAlertInput = (
  payload: SentryIssueAlertEvent,
): IssueAlertInput => ({
  action: payload.action,
  app: extractProjectSlug(payload.data.event.url),
  culprit: payload.data.event.culprit,
  title: payload.data.event.title,
  level: payload.data.event.level,
  webUrl: payload.data.event.web_url,
  triggeredRule: payload.data.triggered_rule,
})

export const buildIssueAlertNotification = (
  input: IssueAlertInput,
): IssueAlertNotification | null => {
  if (input.action !== 'triggered') return null

  const headerText = truncateHeaderText(`🐛 ${input.title}`)
  const fields = [
    buildField('アプリ', input.app),
    buildField('Level', input.level),
    buildField('発生箇所', input.culprit, true),
    buildField('Rule', input.triggeredRule),
  ]
  const issueLink = `<${input.webUrl}|View issue>`
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText },
    },
    {
      type: 'section',
      fields: fields.map((text) => ({ type: 'mrkdwn', text })),
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: issueLink }],
    },
  ]
  const content: SlackMessageContent = {
    text: [
      `🐛 ${escapeSlackMrkdwn(input.title)}`,
      `アプリ: ${escapeSlackMrkdwn(input.app)}`,
      `Level: ${escapeSlackMrkdwn(input.level)}`,
      `発生箇所: \`${escapeSlackMrkdwn(input.culprit)}\``,
      `Rule: ${escapeSlackMrkdwn(input.triggeredRule)}`,
      issueLink,
    ].join('\n'),
    color: SENTRY_ALERT_COLOR,
    blocks,
  }

  return {
    content,
    title: input.title,
    level: input.level,
    webUrl: input.webUrl,
    triggeredRule: input.triggeredRule,
  }
}
