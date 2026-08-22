import type {
  PullRequestClosedEvent,
  PullRequestOpenedEvent,
  WorkflowRunCompletedEvent,
} from '@octokit/webhooks-types'
import { okAsync, type ResultAsync } from 'neverthrow'

import type { GitHubClient } from '#github-client'
import { logger } from '#logger'
import type { SlackApiError, SlackMessageContent, SlackNotifier } from '#slack'
import {
  buildPullRequestNotification,
  extractPullRequestInput,
} from '#sources/github/handlers/pull-request'
import {
  buildWorkflowRunNotification,
  extractWorkflowRunInput,
} from '#sources/github/handlers/workflow-run'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  event: string
  notifier: SlackNotifier
  githubClient: GitHubClient
}

interface ParsedEvent {
  name: string
  payload: unknown
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
      return buildWorkflowRunNotification(input, {
        githubClient: ctx.githubClient,
      }).andThen((note) => {
        if (note === null) return okAsync<DispatchOutcome>('filtered')
        return ctx.notifier
          .postMessage(note.content)
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
      if (note === null) return okAsync('filtered')

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
              )
              .andThen((existing) => {
                if (existing !== null) {
                  return ctx.notifier.updateMessage(existing, content)
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
    default:
      return okAsync('ignored')
  }
}
