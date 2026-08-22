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
import type { SlackApiError, SlackMessageContent, SlackNotifier } from '#slack'
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
} from '#sources/github/handlers/workflow-run'
import { isThirdParty } from '#sources/github/third-party'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  event: string
  notifier: SlackNotifier
  activityChannel: string
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
