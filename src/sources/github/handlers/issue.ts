import type { IssuesOpenedEvent } from '@octokit/webhooks-types'

import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface IssueInput {
  repo: string
  title: string
  url: string
  author: string
}

export interface IssueNotification {
  text: string
  repo: string
  url: string
}

export const extractIssueInput = (payload: IssuesOpenedEvent): IssueInput => ({
  repo: payload.repository.full_name,
  title: payload.issue.title,
  url: payload.issue.html_url,
  author: payload.sender.login,
})

export const buildIssueNotification = (
  input: IssueInput,
): IssueNotification => ({
  text: [
    `:speech_balloon: *New issue opened on \`${escapeSlackMrkdwn(input.repo)}\` by \`${escapeSlackMrkdwn(input.author)}\`*`,
    `*${escapeSlackMrkdwn(input.title)}*`,
    `<${input.url}|View issue>`,
  ].join('\n'),
  repo: input.repo,
  url: input.url,
})
