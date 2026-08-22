import type { IssuesOpenedEvent } from '@octokit/webhooks-types'

import type {
  ThirdPartyActivityInput,
  ThirdPartyActivityNotification,
} from '#sources/github/third-party'
import { buildThirdPartyActivityNotification } from '#sources/github/third-party'

export type IssueInput = ThirdPartyActivityInput
export type IssueNotification = ThirdPartyActivityNotification

export const extractIssueInput = (payload: IssuesOpenedEvent): IssueInput => ({
  repo: payload.repository.full_name,
  title: payload.issue.title,
  url: payload.issue.html_url,
  author: payload.sender.login,
})

export const buildIssueNotification = (input: IssueInput): IssueNotification =>
  buildThirdPartyActivityNotification('issue', input)
