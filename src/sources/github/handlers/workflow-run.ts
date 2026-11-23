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
import type { TqClient, TqTaskRef } from '#plugins/tq/tq-client'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { ALERT_FIELD_LABELS } from '#sources/alert-field-labels'
import {
  type CiAlertRule,
  matchesCiAlertRule,
} from '#sources/github/ci-alert-rules'

export interface WorkflowRunInput {
  repo: string
  repoOwner: string
  repoName: string
  headRepo: string
  workflow: string
  branch: string | null
  defaultBranch: string
  workflowId: number
  conclusion: WorkflowRunCompletedEvent['workflow_run']['conclusion']
  sha: string
  runId: number
  url: string
  event: string
  displayTitle: string
  commitMessage: string
  actor: string | null
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
  tqClient: Pick<TqClient, 'findTaskByGithubUrl'>
}

const getActorLogin = (actor: { login: string } | null): string | null =>
  actor?.login ?? null

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
  actor: getActorLogin(payload.workflow_run.actor),
  triggeringActor: payload.workflow_run.triggering_actor.login,
})

export const isEligibleWorkflowRun = (
  input: WorkflowRunInput,
  ciAlertRules: CiAlertRule[] = [],
  ignoreActor = false,
): input is WorkflowRunInput & { branch: string } => {
  const { branch } = input

  // Fork-originated runs can expose the fork's branch alongside the upstream
  // repository's default branch, so the head repository must also match.
  if (input.headRepo !== input.repo || branch === null) return false

  return (
    branch === input.defaultBranch ||
    ciAlertRules.some((rule) =>
      matchesCiAlertRule(
        rule,
        { repo: input.repo, branch, actor: input.actor },
        ignoreActor,
      ),
    )
  )
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

const normalizeTextLine = (text: string): string =>
  text.replace(/\s+/g, ' ').trim()

const buildOriginLine = (origin: WorkflowOrigin): string | null => {
  if (origin === null) return null
  if (origin.type === 'text') {
    return escapeSlackMrkdwn(normalizeTextLine(origin.value))
  }

  const { number, title, url } = origin.pullRequest
  return `<${url}|#${String(number)} ${escapeSlackMrkdwn(title)}>`
}

// CommonMark can parse these characters as HTML markup or entities in TQ descriptions.
const formatTaskDescriptionText = (text: string): string =>
  normalizeTextLine(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/#\d+\b/g, (reference) => `\`${reference}\``)

const formatTaskDescriptionCode = (text: string): string => {
  const normalizedText = normalizeTextLine(text)
  const backtickSequences = normalizedText.match(/`+/g) ?? []
  const delimiter = '`'.repeat(
    Math.max(1, ...backtickSequences.map((sequence) => sequence.length + 1)),
  )
  const content =
    normalizedText.startsWith('`') || normalizedText.endsWith('`')
      ? ` ${normalizedText} `
      : normalizedText
  return `${delimiter}${content}${delimiter}`
}

const buildTaskOrigin = (
  origin: WorkflowOrigin,
  originTask: TqTaskRef | null,
): string => {
  if (origin === null) return 'なし'
  if (origin.type === 'text') return formatTaskDescriptionText(origin.value)

  const { title, url } = origin.pullRequest
  const taskMention =
    originTask === null ? '' : ` (tq #${String(originTask.number)})`
  return `${formatTaskDescriptionText(title)} ${url}${taskMention}`
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
  const normalizedStep = normalizeTextLine(step)
  const strippedStep = normalizedStep
    .replace(/@[0-9a-f]{7,40}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return strippedStep === '' ? normalizedStep : strippedStep
}

const buildTaskDescription = (
  input: WorkflowRunInput & { branch: string },
  failedStep: FailedStep | null,
  origin: WorkflowOrigin,
  originTask: TqTaskRef | null,
  trigger: string,
): string => {
  const repo = formatTaskDescriptionText(input.repo)
  const branch = formatTaskDescriptionText(input.branch)
  const workflow = formatTaskDescriptionText(input.workflow)
  const failedStepDescription =
    failedStep === null
      ? '不明'
      : `${formatTaskDescriptionCode(failedStep.job)} › ${formatTaskDescriptionCode(stripStepSha(failedStep.step))}`
  const runStatus =
    input.conclusion === 'cancelled' ? 'キャンセルされている' : '失敗している'
  const nextAction =
    input.conclusion === 'cancelled'
      ? '停止箇所を確認する。'
      : '失敗箇所を直す。'

  return [
    '## なぜやるか',
    '',
    `${repo} の ${branch} で ${workflow} が${runStatus}。`,
    '',
    `- 起点の PR: ${buildTaskOrigin(origin, originTask)}`,
    `- トリガー: ${trigger}`,
    '',
    '## やること',
    '',
    nextAction,
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
  input: WorkflowRunInput & { branch: string },
  failedStep: FailedStep | null,
  pullRequest: PullRequestSummary | null,
  originTask: TqTaskRef | null,
): WorkflowRunNotification => {
  const workflowName = normalizeTextLine(input.workflow)
  const runStatus = input.conclusion === 'cancelled' ? 'cancelled' : 'failed'
  const taskStatus = input.conclusion === 'cancelled' ? 'キャンセル' : '失敗'
  const headerText = truncateHeaderText(`🚨 ${input.workflow} ${runStatus}`)
  const origin = resolveWorkflowOrigin(input, pullRequest)
  const originLine = buildOriginLine(origin)
  const triggerLabels = buildTriggerLabels(input)
  const failedStepValue =
    failedStep === null
      ? null
      : `\`${escapeSlackMrkdwn(normalizeTextLine(failedStep.job))}\` › \`${escapeSlackMrkdwn(normalizeTextLine(failedStep.step))}\``

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
      title: `${input.repo}: ${workflowName} が${taskStatus}`,
      description: buildTaskDescription(
        input,
        failedStep,
        origin,
        originTask,
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

const lookupOriginTask = (
  input: WorkflowRunInput,
  pullRequest: PullRequestSummary | null,
  tqClient: WorkflowRunNotificationDeps['tqClient'],
): ResultAsync<TqTaskRef | null, never> => {
  if (input.event !== 'push' || pullRequest === null) return okAsync(null)

  return tqClient.findTaskByGithubUrl(pullRequest.url).orElse((error) => {
    logger.warn(
      { err: error, repo: input.repo, url: pullRequest.url },
      'tq_github_link_lookup_failed',
    )
    return okAsync(null)
  })
}

export const buildWorkflowRunNotification = (
  input: WorkflowRunInput,
  deps: WorkflowRunNotificationDeps,
  ciAlertRules: CiAlertRule[] = [],
): ResultAsync<WorkflowRunNotification | null, never> => {
  if (input.conclusion !== 'failure' && input.conclusion !== 'cancelled')
    return okAsync(null)
  if (!isEligibleWorkflowRun(input, ciAlertRules)) return okAsync(null)

  const stepLookup =
    input.conclusion === 'failure'
      ? deps.githubClient
          .findFailedStep(input.repoOwner, input.repoName, input.runId)
          .map((step) => ({ type: 'notification' as const, step }))
      : deps.githubClient
          .findCancelledWorkflowRun(
            input.repoOwner,
            input.repoName,
            input.runId,
          )
          .map((run) => {
            if (run.annotationLookupError !== null) {
              reportGitHubApiFailure(run.annotationLookupError, {
                repo: input.repo,
                run_id: input.runId,
              })
              logger.warn(
                {
                  err: run.annotationLookupError,
                  repo: input.repo,
                  run_id: input.runId,
                },
                'github_api_cancelled_run_annotation_lookup_failed',
              )
            }

            return run.type === 'superseded'
              ? { type: 'superseded' as const }
              : { type: 'notification' as const, step: run.step }
          })
  const stepLookupWithFallback = stepLookup.orElse((error) => {
    reportGitHubApiFailure(error, {
      repo: input.repo,
      run_id: input.runId,
    })
    logger.warn(
      { err: error, repo: input.repo, run_id: input.runId },
      input.conclusion === 'cancelled'
        ? 'github_api_cancelled_run_lookup_failed'
        : 'github_api_failed_step_lookup_failed',
    )
    return okAsync({ type: 'notification' as const, step: null })
  })

  // PR lookup only applies to `push` runs, where the PR must be inferred
  // from the commit sha; every other event either has no PR (schedule,
  // workflow_dispatch) or already reports its own context via
  // displayTitle, so skip the lookup rather than call the API for nothing.
  // Default-branch commits can point to merged PRs from other branches, while
  // a non-default run must use a PR from that same head branch.
  const lookupPullRequest = () => {
    if (input.event !== 'push') return okAsync<PullRequestSummary | null>(null)

    const pullRequest =
      input.branch === input.defaultBranch
        ? deps.githubClient.findPullRequestForCommit(
            input.repoOwner,
            input.repoName,
            input.sha,
          )
        : deps.githubClient.findPullRequestForCommit(
            input.repoOwner,
            input.repoName,
            input.sha,
            input.branch,
          )

    return pullRequest.orElse((error) => {
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
  }

  return stepLookupWithFallback.andThen((result) => {
    if (result.type === 'superseded') return okAsync(null)

    const step = result.step
    return lookupPullRequest().andThen((pr) =>
      lookupOriginTask(input, pr, deps.tqClient).map((originTask) =>
        formatWorkflowRunNotification(input, step, pr, originTask),
      ),
    )
  })
}
