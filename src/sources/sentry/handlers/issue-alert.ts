import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { ALERT_FIELD_LABELS } from '#sources/alert-field-labels'

export interface SentryIssueAlertEvent {
  action: string
  data: {
    event: {
      title: string
      level: string
      web_url: string
      url?: string | null
      culprit?: string | null
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
  task: CreateTaskRequest
  title: string
  level: string
  webUrl: string
  triggeredRule: string
}

const SENTRY_ALERT_COLOR = '#d73a49'
// Slack header blocks use plain_text and are limited to 150 characters.
const HEADER_TEXT_MAX_LENGTH = 150

const extractProjectSlug = (eventUrl: string | null | undefined): string =>
  eventUrl?.split('/projects/')[1]?.split('/')[1] ?? ''

const truncateHeaderText = (text: string): string =>
  text.length > HEADER_TEXT_MAX_LENGTH
    ? `${text.slice(0, HEADER_TEXT_MAX_LENGTH - 1)}…`
    : text

const renderFieldValue = (value: string, asCode: boolean): string =>
  asCode ? `\`${escapeSlackMrkdwn(value)}\`` : escapeSlackMrkdwn(value)

export const extractIssueAlertInput = (
  payload: SentryIssueAlertEvent,
): IssueAlertInput => ({
  action: payload.action,
  app: extractProjectSlug(payload.data.event.url),
  culprit: payload.data.event.culprit ?? '',
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
  const fieldDefinitions = [
    { label: ALERT_FIELD_LABELS.sentryApp, value: input.app, asCode: false },
    { label: 'Level', value: input.level, asCode: false },
    { label: '発生箇所', value: input.culprit, asCode: true },
    { label: 'Rule', value: input.triggeredRule, asCode: false },
  ]
  const fields = fieldDefinitions
    .filter(({ value }) => value !== '')
    .map(({ label, value, asCode }) => ({
      type: 'mrkdwn' as const,
      text: `*${label}*\n${renderFieldValue(value, asCode)}`,
    }))
  const issueLink = `<${input.webUrl}|View issue>`
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: issueLink }],
    },
  ]
  const content: SlackMessageContent = {
    text: `🐛 ${input.title}`,
    color: SENTRY_ALERT_COLOR,
    blocks,
  }

  return {
    content,
    task: {
      title: `Sentry alert: ${input.title}`,
      description: [
        `Application: ${input.app || 'Unknown'}`,
        `Issue: ${input.title}`,
        `Level: ${input.level}`,
        `Location: ${input.culprit || 'Unknown'}`,
        `Rule: ${input.triggeredRule}`,
        `Issue URL: ${input.webUrl}`,
      ].join('\n'),
      context: 'personal',
    },
    title: input.title,
    level: input.level,
    webUrl: input.webUrl,
    triggeredRule: input.triggeredRule,
  }
}
