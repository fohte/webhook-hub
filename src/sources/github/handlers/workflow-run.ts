import { captureWithFingerprint } from '@fohte/service-kit/observability'
import type { WorkflowRunCompletedEvent } from '@octokit/webhooks-types'
import { okAsync, type ResultAsync } from 'neverthrow'

import {
  type FailedStep,
  type GitHubApiError,
  GitHubAuthError,
  type GitHubClient,
  type PullRequestSummary,
} from '#github-client'
import { logger } from '#logger'
import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { ALERT_FIELD_LABELS } from '#sources/alert-field-labels'

export interface WorkflowRunInput {
  repo: string
  repoOwner: string
  repoName: string
  headRepo: string
  workflow: string
  branch: string
  defaultBranch: string
  workflowId: number
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
  task: CreateTaskRequest
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
  workflowId: payload.workflow_run.workflow_id,
  conclusion: payload.workflow_run.conclusion,
  sha: payload.workflow_run.head_sha,
  runId: payload.workflow_run.id,
  url: payload.workflow_run.html_url,
  event: payload.workflow_run.event,
  displayTitle: payload.workflow_run.display_title,
  commitMessage: payload.workflow_run.head_commit.message,
  triggeringActor: payload.workflow_run.triggering_actor.login,
})

export const isEligibleWorkflowRun = (input: WorkflowRunInput): boolean => {
  // Fork-originated runs can expose the fork's branch alongside the upstream
  // repository's default branch, so the head repository must also match.
  return input.headRepo === input.repo && input.branch === input.defaultBranch
}

// octo-sts token acquisition failing is a persistent auth outage, not a
// one-off API blip, so it gets its own fingerprint: the same issue keeps
// accumulating events instead of getting lost among transient GitHub API
// failures.
const OCTO_STS_AUTH_FAILURE_FINGERPRINT = 'webhook-hub.octo-sts-auth-failed'
const GITHUB_API_LOOKUP_FAILURE_FINGERPRINT =
  'webhook-hub.github-api-lookup-failed'

const reportGitHubApiFailure = (
  error: GitHubApiError,
  extras: Record<string, unknown>,
): void => {
  const fingerprint =
    error instanceof GitHubAuthError
      ? OCTO_STS_AUTH_FAILURE_FINGERPRINT
      : GITHUB_API_LOOKUP_FAILURE_FINGERPRINT
  captureWithFingerprint(error, fingerprint, { extras })
}

const FAILURE_COLOR = '#d73a49'
const GITHUB_CI_USERNAME = 'GitHub CI'
const GITHUB_CI_ICON_URL = 'https://avatars.githubusercontent.com/in/15368'
// Slack header blocks are plain_text and hard-capped at 150 characters.
const HEADER_TEXT_MAX_LENGTH = 150

const truncateHeaderText = (text: string): string =>
  text.length > HEADER_TEXT_MAX_LENGTH
    ? `${text.slice(0, HEADER_TEXT_MAX_LENGTH - 1)}…`
    : text

type WorkflowOrigin =
  | { type: 'pull_request'; pullRequest: PullRequestSummary }
  | { type: 'text'; value: string }
  | null

const resolveWorkflowOrigin = (
  input: WorkflowRunInput,
  pullRequest: PullRequestSummary | null,
): WorkflowOrigin => {
  switch (input.event) {
    case 'push':
      if (pullRequest !== null) {
        return { type: 'pull_request', pullRequest }
      }
      return { type: 'text', value: input.commitMessage.split('\n')[0] ?? '' }
    case 'schedule':
    case 'workflow_dispatch':
      return null
    default:
      return { type: 'text', value: input.displayTitle }
  }
}

const buildOriginLine = (origin: WorkflowOrigin): string | null => {
  if (origin === null) return null
  if (origin.type === 'text') return escapeSlackMrkdwn(origin.value)

  const { number, title, url } = origin.pullRequest
  return `<${url}|#${String(number)} ${escapeSlackMrkdwn(title)}>`
}

// CommonMark can parse these characters as HTML markup or entities in TQ descriptions.
const formatTaskDescriptionText = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/#\d+\b/g, (reference) => `\`${reference}\``)

const buildTaskOrigin = (origin: WorkflowOrigin): string => {
  if (origin === null) return 'なし'
  if (origin.type === 'text') return formatTaskDescriptionText(origin.value)

  const { title, url } = origin.pullRequest
  return `${formatTaskDescriptionText(title)} ${url}`
}

interface WorkflowTriggerLabels {
  slack: string
  task: string
}

const buildTriggerLabels = (input: WorkflowRunInput): WorkflowTriggerLabels => {
  switch (input.event) {
    case 'push':
      return { slack: 'push', task: 'push' }
    case 'schedule':
      return { slack: '定期実行', task: '定期実行' }
    case 'workflow_dispatch':
      return {
        slack: `\`@${escapeSlackMrkdwn(input.triggeringActor)}\` が手動実行`,
        task: `@${formatTaskDescriptionText(input.triggeringActor)} が手動実行`,
      }
    default:
      return {
        slack: `\`${escapeSlackMrkdwn(input.event)}\` 起因`,
        task: `${formatTaskDescriptionText(input.event)} 起因`,
      }
  }
}

const stripStepSha = (step: string): string => {
  const strippedStep = step
    .replace(/@[0-9a-f]{7,40}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return strippedStep === '' ? step : strippedStep
}

const buildTaskDescription = (
  input: WorkflowRunInput,
  failedStep: FailedStep | null,
  origin: WorkflowOrigin,
  trigger: string,
): string => {
  const repo = formatTaskDescriptionText(input.repo)
  const branch = formatTaskDescriptionText(input.defaultBranch)
  const workflow = formatTaskDescriptionText(input.workflow)
  const failedStepDescription =
    failedStep === null
      ? '不明'
      : `${formatTaskDescriptionText(failedStep.job)} / ${formatTaskDescriptionText(stripStepSha(failedStep.step))}`

  return [
    '## なぜやるか',
    '',
    `${repo} の ${branch} で ${workflow} が失敗している。`,
    '',
    `- 起点: ${buildTaskOrigin(origin)}`,
    `- トリガー: ${trigger}`,
    '',
    '## やること',
    '',
    '失敗箇所を直す。',
    '',
    `- 失敗箇所: ${failedStepDescription}`,
    `- Run: ${input.url}`,
    '',
    '## 完了条件',
    '',
    `- [ ] ${branch} の ${workflow} が成功する`,
  ].join('\n')
}

const buildContextText = (input: WorkflowRunInput): string => {
  return `<${input.url}|View run>`
}

const formatWorkflowRunNotification = (
  input: WorkflowRunInput,
  failedStep: FailedStep | null,
  pullRequest: PullRequestSummary | null,
): WorkflowRunNotification => {
  const headerText = truncateHeaderText(`🚨 ${input.workflow} failed`)
  const origin = resolveWorkflowOrigin(input, pullRequest)
  const originLine = buildOriginLine(origin)
  const triggerLabels = buildTriggerLabels(input)
  const failedStepValue =
    failedStep === null
      ? null
      : `\`${escapeSlackMrkdwn(failedStep.job)}\` › \`${escapeSlackMrkdwn(failedStep.step)}\``

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText } },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*${ALERT_FIELD_LABELS.repository}*\n${escapeSlackMrkdwn(input.repo)}`,
        },
        {
          type: 'mrkdwn',
          text: `*${ALERT_FIELD_LABELS.originPullRequest}*\n${originLine ?? 'なし'}`,
        },
        {
          type: 'mrkdwn',
          text: `*失敗箇所*\n${failedStepValue ?? '不明'}`,
        },
        {
          type: 'mrkdwn',
          text: `*トリガー*\n${triggerLabels.slack}`,
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: buildContextText(input) }],
    },
  ]

  return {
    content: {
      text: headerText,
      color: FAILURE_COLOR,
      blocks,
      username: GITHUB_CI_USERNAME,
      iconUrl: GITHUB_CI_ICON_URL,
    },
    task: {
      title: `${input.repo}: ${input.workflow} が失敗`,
      description: buildTaskDescription(
        input,
        failedStep,
        origin,
        triggerLabels.task,
      ),
      context: 'personal',
      labels: ['alert/ci', `dev/${input.repoName}`],
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
  if (!isEligibleWorkflowRun(input)) return okAsync(null)

  const failedStep = deps.githubClient
    .findFailedStep(input.repoOwner, input.repoName, input.runId)
    .orElse((error) => {
      reportGitHubApiFailure(error, {
        repo: input.repo,
        run_id: input.runId,
      })
      logger.warn(
        { err: error, repo: input.repo, run_id: input.runId },
        'github_api_failed_step_lookup_failed',
      )
      return okAsync(null)
    })

  // PR lookup only applies to `push` runs, where the PR must be inferred
  // from the commit sha; every other event either has no PR (schedule,
  // workflow_dispatch) or already reports its own context via
  // displayTitle, so skip the lookup rather than call the API for nothing.
  const pullRequest =
    input.event === 'push'
      ? deps.githubClient
          .findPullRequestForCommit(input.repoOwner, input.repoName, input.sha)
          .orElse((error) => {
            reportGitHubApiFailure(error, {
              repo: input.repo,
              sha: input.sha,
            })
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
