import type { WorkflowRunCompletedEvent } from '@octokit/webhooks-types'
import { okAsync, type ResultAsync } from 'neverthrow'

import type {
  FailedStep,
  GitHubClient,
  PullRequestSummary,
} from '#github-client'
import { logger } from '#logger'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface WorkflowRunInput {
  repo: string
  repoOwner: string
  repoName: string
  headRepo: string
  workflow: string
  branch: string
  defaultBranch: string
  conclusion: WorkflowRunCompletedEvent['workflow_run']['conclusion']
  sha: string
  runId: number
  url: string
  event: string
  displayTitle: string
  commitMessage: string
  triggeringActor: string
}

export interface WorkflowRunNotification {
  content: SlackMessageContent
  repo: string
  workflow: string
  url: string
}

export interface WorkflowRunNotificationDeps {
  githubClient: GitHubClient
}

export const extractWorkflowRunInput = (
  payload: WorkflowRunCompletedEvent,
): WorkflowRunInput => ({
  repo: payload.repository.full_name,
  repoOwner: payload.repository.owner.login,
  repoName: payload.repository.name,
  headRepo: payload.workflow_run.head_repository.full_name,
  workflow: payload.workflow_run.name,
  branch: payload.workflow_run.head_branch,
  defaultBranch: payload.repository.default_branch,
  conclusion: payload.workflow_run.conclusion,
  sha: payload.workflow_run.head_sha,
  runId: payload.workflow_run.id,
  url: payload.workflow_run.html_url,
  event: payload.workflow_run.event,
  displayTitle: payload.workflow_run.display_title,
  commitMessage: payload.workflow_run.head_commit.message,
  triggeringActor: payload.workflow_run.triggering_actor.login,
})

const FAILURE_COLOR = '#d73a49'
const GITHUB_CI_USERNAME = 'GitHub CI'
const GITHUB_CI_ICON_URL = 'https://avatars.githubusercontent.com/in/15368'
// Slack header blocks are plain_text and hard-capped at 150 characters.
const HEADER_TEXT_MAX_LENGTH = 150

const truncateHeaderText = (text: string): string =>
  text.length > HEADER_TEXT_MAX_LENGTH
    ? `${text.slice(0, HEADER_TEXT_MAX_LENGTH - 1)}…`
    : text

const buildBodyLine = (
  input: WorkflowRunInput,
  pullRequest: PullRequestSummary | null,
): string | null => {
  switch (input.event) {
    case 'push':
      if (pullRequest !== null) {
        return `<${pullRequest.url}|#${String(pullRequest.number)} ${escapeSlackMrkdwn(pullRequest.title)}>`
      }
      return escapeSlackMrkdwn(input.commitMessage.split('\n')[0] ?? '')
    case 'schedule':
    case 'workflow_dispatch':
      return null
    default:
      return escapeSlackMrkdwn(input.displayTitle)
  }
}

const buildTriggerLabel = (input: WorkflowRunInput): string | null => {
  switch (input.event) {
    case 'push':
      return null
    case 'schedule':
      return '定期実行'
    case 'workflow_dispatch':
      return `\`@${escapeSlackMrkdwn(input.triggeringActor)}\` が手動実行`
    default:
      return `\`${escapeSlackMrkdwn(input.event)}\` 起因`
  }
}

const buildContextText = (input: WorkflowRunInput): string => {
  const triggerLabel = buildTriggerLabel(input)
  return [
    escapeSlackMrkdwn(input.repo),
    ...(triggerLabel === null ? [] : [triggerLabel]),
    `<${input.url}|View run>`,
  ].join(' · ')
}

const formatWorkflowRunNotification = (
  input: WorkflowRunInput,
  failedStep: FailedStep | null,
  pullRequest: PullRequestSummary | null,
): WorkflowRunNotification => {
  const headerText = truncateHeaderText(`🚨 ${input.workflow} failed`)
  const bodyLine = buildBodyLine(input, pullRequest)
  const failedStepLine =
    failedStep === null
      ? null
      : `失敗: \`${escapeSlackMrkdwn(failedStep.job)}\` › \`${escapeSlackMrkdwn(failedStep.step)}\``

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText } },
  ]
  if (bodyLine !== null) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: bodyLine } })
  }
  if (failedStepLine !== null) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: failedStepLine },
    })
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: buildContextText(input) }],
  })

  return {
    content: {
      text: headerText,
      color: FAILURE_COLOR,
      blocks,
      username: GITHUB_CI_USERNAME,
      iconUrl: GITHUB_CI_ICON_URL,
    },
    repo: input.repo,
    workflow: input.workflow,
    url: input.url,
  }
}

export const buildWorkflowRunNotification = (
  input: WorkflowRunInput,
  deps: WorkflowRunNotificationDeps,
): ResultAsync<WorkflowRunNotification | null, never> => {
  if (input.conclusion !== 'failure') return okAsync(null)
  // Fork-originated runs surface upstream's `repository.default_branch` with the
  // fork's `head_branch` (often also `main`), which would otherwise pass the branch check.
  if (input.headRepo !== input.repo) return okAsync(null)
  if (input.branch !== input.defaultBranch) return okAsync(null)

  const failedStep = deps.githubClient
    .findFailedStep(input.repoOwner, input.repoName, input.runId)
    .orElse((error) => {
      logger.warn(
        { err: error, repo: input.repo, runId: input.runId },
        'github_api_failed_step_lookup_failed',
      )
      return okAsync(null)
    })

  // schedule/workflow_dispatch runs don't originate from a specific commit's
  // PR, so skip the lookup entirely rather than call the API for nothing.
  const pullRequest =
    input.event === 'push'
      ? deps.githubClient
          .findPullRequestForCommit(input.repoOwner, input.repoName, input.sha)
          .orElse((error) => {
            logger.warn(
              { err: error, repo: input.repo, sha: input.sha },
              'github_api_pull_request_lookup_failed',
            )
            return okAsync(null)
          })
      : okAsync(null)

  return failedStep.andThen((step) =>
    pullRequest.map((pr) => formatWorkflowRunNotification(input, step, pr)),
  )
}
