import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface SentryIssueAlertEvent {
  action: string
  data: {
    event: {
      title: string
      level: string
      web_url: string
    }
    triggered_rule: string
  }
}

export interface IssueAlertInput {
  action: string
  title: string
  level: string
  webUrl: string
  triggeredRule: string
}

export interface IssueAlertNotification {
  text: string
  title: string
  level: string
  webUrl: string
  triggeredRule: string
}

export const extractIssueAlertInput = (
  payload: SentryIssueAlertEvent,
): IssueAlertInput => ({
  action: payload.action,
  title: payload.data.event.title,
  level: payload.data.event.level,
  webUrl: payload.data.event.web_url,
  triggeredRule: payload.data.triggered_rule,
})

export const buildIssueAlertNotification = (
  input: IssueAlertInput,
): IssueAlertNotification | null => {
  if (input.action !== 'triggered') return null

  const text = [
    `:rotating_light: *Sentry alert: ${escapeSlackMrkdwn(input.title)}*`,
    `Level: *${escapeSlackMrkdwn(input.level)}* / Rule: *${escapeSlackMrkdwn(input.triggeredRule)}*`,
    `<${input.webUrl}|View issue>`,
  ].join('\n')

  return {
    text,
    title: input.title,
    level: input.level,
    webUrl: input.webUrl,
    triggeredRule: input.triggeredRule,
  }
}
