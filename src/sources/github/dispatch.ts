import { randomUUID } from 'node:crypto'

import type {
  IssuesOpenedEvent,
  PullRequestClosedEvent,
  PullRequestOpenedEvent,
  StarCreatedEvent,
  WorkflowRunCompletedEvent,
} from '@octokit/webhooks-types'
import { okAsync, type ResultAsync } from 'neverthrow'

import type { GitHubClient } from '#github-client'
import { logger } from '#logger'
import { setSourceAlertResolved } from '#plugins/tq/alert-source-appearance'
import { addTqTaskStatus, createAlertTask } from '#plugins/tq/alert-task'
import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task-snapshot'
import { type TqClient } from '#plugins/tq/tq-client'
import type {
  SlackApiError,
  SlackMessageContent,
  SlackMessageMetadata,
  SlackNotifier,
} from '#slack'
import {
  buildIssueNotification,
  extractIssueInput,
} from '#sources/github/handlers/issue'
import {
  buildPullRequestNotification,
  buildThirdPartyPullRequestNotification,
  extractPullRequestInput,
  extractThirdPartyPullRequestInput,
} from '#sources/github/handlers/pull-request'
import {
  buildStarNotification,
  extractStarInput,
} from '#sources/github/handlers/star'
import {
  buildWorkflowRunNotification,
  extractWorkflowRunInput,
  isEligibleWorkflowRun,
  type WorkflowRunInput,
} from '#sources/github/handlers/workflow-run'
import { isThirdParty } from '#sources/github/third-party'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  event: string
  notifier: SlackNotifier
  activityChannel: string
  githubClient: GitHubClient
  tqClient: TqClient
  tqWebUrl: string
}

interface ParsedEvent {
  name: string
  payload: unknown
}

const createWorkflowRunAlertMetadata = (
  input: WorkflowRunInput,
  taskId: string | null,
): SlackMessageMetadata => ({
  event_type: 'alert_task',
  event_payload: {
    ...(taskId === null ? {} : { task_id: taskId }),
    github_repo: input.repo,
    github_workflow_id: input.workflowId,
    github_branch: input.branch,
    github_workflow_run_id: input.runId,
    github_alert_id: randomUUID(),
  },
})

const resolveWorkflowRunAlerts = (
  ctx: DispatchContext,
  input: WorkflowRunInput,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  if (!isEligibleWorkflowRun(input)) return okAsync('filtered')

  const skippedAlertIds = new Set<unknown>()
  let resolvedAny = false
  const finish = (): ResultAsync<DispatchOutcome, SlackApiError> =>
    okAsync(resolvedAny ? 'notified' : 'filtered')

  const resolveNext = (): ResultAsync<DispatchOutcome, SlackApiError> =>
    ctx.notifier
      .findMessageByMetadata(
        'alert_task',
        (payload) => {
          const alertId = payload['github_alert_id']
          const alertRunId = payload['github_workflow_run_id']
          return (
            payload['github_repo'] === input.repo &&
            payload['github_workflow_id'] === input.workflowId &&
            payload['github_branch'] === input.branch &&
            typeof alertRunId === 'number' &&
            alertRunId <= input.runId &&
            typeof alertId === 'string' &&
            !skippedAlertIds.has(alertId) &&
            payload[TQ_ORIGINAL_CONTENT_KEY] === undefined
          )
        },
        { maxPages: 2 },
      )
      .andThen((message) => {
        if (message === null) {
          return finish()
        }

        skippedAlertIds.add(message.eventPayload['github_alert_id'])

        if (message.content === undefined) return resolveNext()

        const content = setSourceAlertResolved(message.content, true)
        if (content === message.content) return resolveNext()

        return ctx.notifier.updateMessage(message.ref, content).andThen(() => {
          resolvedAny = true
          logger.info(
            {
              delivery_id: ctx.deliveryId,
              event: 'workflow_run',
              repo: input.repo,
              workflow: input.workflow,
              branch: input.branch,
              run_id: input.runId,
            },
            'github_workflow_alert_resolved',
          )
          return resolveNext()
        })
      })

  return resolveNext()
}

const hasAnyAction = (
  payload: unknown,
  actions: readonly string[],
): payload is { action: string } =>
  typeof payload === 'object' &&
  payload !== null &&
  'action' in payload &&
  typeof payload.action === 'string' &&
  actions.includes(payload.action)

export const dispatch = (
  ctx: DispatchContext,
  parsed: ParsedEvent,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  switch (parsed.name) {
    case 'workflow_run': {
      if (!hasAnyAction(parsed.payload, ['completed']))
        return okAsync('ignored')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload union refinement
      const typed = parsed.payload as WorkflowRunCompletedEvent
      const input = extractWorkflowRunInput(typed)
      if (input.conclusion === 'success') {
        return resolveWorkflowRunAlerts(ctx, input)
      }
      return buildWorkflowRunNotification(input, {
        githubClient: ctx.githubClient,
      }).andThen((note) => {
        if (note === null) return okAsync<DispatchOutcome>('filtered')
        return createAlertTask(ctx.tqClient, note.task, {
          delivery_id: ctx.deliveryId,
          event: 'workflow_run',
          repo: note.repo,
        })
          .andThen((task) => {
            const content = addTqTaskStatus(
              note.content,
              task,
              ctx.tqWebUrl,
              createWorkflowRunAlertMetadata(input, task?.id ?? null),
            )
            return ctx.notifier.postMessage(content)
          })
          .map((): DispatchOutcome => {
            logger.info(
              {
                delivery_id: ctx.deliveryId,
                event: 'workflow_run',
                repo: note.repo,
                workflow: note.workflow,
                url: note.url,
              },
              'slack_notified',
            )
            return 'notified'
          })
      })
    }
    case 'pull_request': {
      if (!hasAnyAction(parsed.payload, ['opened', 'closed']))
        return okAsync('ignored')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload union refinement
      const typed = parsed.payload as
        PullRequestOpenedEvent | PullRequestClosedEvent
      const note = buildPullRequestNotification(extractPullRequestInput(typed))
      if (note === null) {
        if (typed.action !== 'opened' || !isThirdParty(typed))
          return okAsync('filtered')

        const activityNote = buildThirdPartyPullRequestNotification(
          extractThirdPartyPullRequestInput(typed),
        )
        return ctx.notifier
          .postMessage({
            text: activityNote.text,
            channel: ctx.activityChannel,
          })
          .map((): DispatchOutcome => {
            logger.info(
              {
                delivery_id: ctx.deliveryId,
                event: 'pull_request',
                repo: activityNote.repo,
                url: activityNote.url,
              },
              'slack_notified',
            )
            return 'notified'
          })
      }

      const content: SlackMessageContent = {
        text: note.text,
        color: note.color,
        metadata: note.metadata,
      }

      const posted: ResultAsync<void, SlackApiError> =
        note.state === 'opened'
          ? ctx.notifier.postMessage(content).map(() => undefined)
          : ctx.notifier
              .findMessageByMetadata(
                'security_pr',
                (p) => p['pr_url'] === note.url,
                { maxPages: 1 },
              )
              .andThen((existing) => {
                if (existing !== null) {
                  return ctx.notifier.updateMessage(existing.ref, content)
                }
                logger.info(
                  {
                    delivery_id: ctx.deliveryId,
                    event: 'pull_request',
                    state: note.state,
                    url: note.url,
                  },
                  'slack_original_not_found',
                )
                return ctx.notifier.postMessage(content).map(() => undefined)
              })

      return posted.map((): DispatchOutcome => {
        logger.info(
          {
            delivery_id: ctx.deliveryId,
            event: 'pull_request',
            state: note.state,
            repo: note.repo,
            url: note.url,
          },
          'slack_notified',
        )
        return 'notified'
      })
    }
    case 'star': {
      if (!hasAnyAction(parsed.payload, ['created'])) return okAsync('ignored')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload union refinement
      const typed = parsed.payload as StarCreatedEvent
      const note = buildStarNotification(extractStarInput(typed))

      const content: SlackMessageContent = {
        text: note.text,
        channel: ctx.activityChannel,
      }

      return ctx.notifier.postMessage(content).map((): DispatchOutcome => {
        logger.info(
          {
            delivery_id: ctx.deliveryId,
            event: 'star',
            repo: note.repo,
            sender: note.sender,
          },
          'slack_notified',
        )
        return 'notified'
      })
    }
    case 'issues': {
      if (!hasAnyAction(parsed.payload, ['opened'])) return okAsync('ignored')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload union refinement
      const typed = parsed.payload as IssuesOpenedEvent
      if (!isThirdParty(typed)) return okAsync('filtered')

      const note = buildIssueNotification(extractIssueInput(typed))
      return ctx.notifier
        .postMessage({ text: note.text, channel: ctx.activityChannel })
        .map((): DispatchOutcome => {
          logger.info(
            {
              delivery_id: ctx.deliveryId,
              event: 'issues',
              repo: note.repo,
              url: note.url,
            },
            'slack_notified',
          )
          return 'notified'
        })
    }
    default:
      return okAsync('ignored')
  }
}
