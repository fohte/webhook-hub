import type {
  PullRequestClosedEvent,
  PullRequestOpenedEvent,
} from '@octokit/webhooks-types'

import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export type PullRequestState = 'opened' | 'closed' | 'merged'

export interface PullRequestInput {
  repo: string
  title: string
  branch: string
  url: string
  state: PullRequestState
}

export interface PullRequestNotification {
  text: string
  color: string
  metadata: {
    event_type: 'security_pr'
    event_payload: { pr_url: string }
  }
  repo: string
  title: string
  url: string
  state: PullRequestState
}

const SECURITY_TITLE_SUFFIX = /\[security\]\s*$/
const RENOVATE_VULN_BRANCH = /^renovate\/.*-vulnerability$/

const STATE_COLOR: Record<PullRequestState, string> = {
  opened: '#36a64f',
  merged: '#6f42c1',
  closed: '#d73a49',
}

export const extractPullRequestInput = (
  payload: PullRequestOpenedEvent | PullRequestClosedEvent,
): PullRequestInput => ({
  repo: payload.repository.full_name,
  title: payload.pull_request.title,
  branch: payload.pull_request.head.ref,
  url: payload.pull_request.html_url,
  state:
    payload.action === 'opened'
      ? 'opened'
      : payload.pull_request.merged
        ? 'merged'
        : 'closed',
})

export const isSecurityPullRequest = (input: PullRequestInput): boolean =>
  SECURITY_TITLE_SUFFIX.test(input.title) ||
  RENOVATE_VULN_BRANCH.test(input.branch)

export const buildPullRequestNotification = (
  input: PullRequestInput,
): PullRequestNotification | null => {
  if (!isSecurityPullRequest(input)) return null

  const text = [
    `:lock: *Security PR ${input.state} on \`${escapeSlackMrkdwn(input.repo)}\`*`,
    `*${escapeSlackMrkdwn(input.title)}*`,
    `<${input.url}|View pull request>`,
  ].join('\n')

  return {
    text,
    color: STATE_COLOR[input.state],
    metadata: {
      event_type: 'security_pr',
      event_payload: { pr_url: input.url },
    },
    repo: input.repo,
    title: input.title,
    url: input.url,
    state: input.state,
  }
}

export interface ThirdPartyPullRequestInput {
  repo: string
  title: string
  url: string
  author: string
}

export interface ThirdPartyPullRequestNotification {
  text: string
  repo: string
  url: string
}

export const extractThirdPartyPullRequestInput = (
  payload: PullRequestOpenedEvent,
): ThirdPartyPullRequestInput => ({
  repo: payload.repository.full_name,
  title: payload.pull_request.title,
  url: payload.pull_request.html_url,
  author: payload.sender.login,
})

export const buildThirdPartyPullRequestNotification = (
  input: ThirdPartyPullRequestInput,
): ThirdPartyPullRequestNotification => ({
  text: [
    `:speech_balloon: *New pull request opened on \`${escapeSlackMrkdwn(input.repo)}\` by \`${escapeSlackMrkdwn(input.author)}\`*`,
    `*${escapeSlackMrkdwn(input.title)}*`,
    `<${input.url}|View pull request>`,
  ].join('\n'),
  repo: input.repo,
  url: input.url,
})
