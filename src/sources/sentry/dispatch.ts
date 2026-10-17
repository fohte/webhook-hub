import { errAsync, okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import { setSourceAlertResolved } from '#plugins/tq/alert-source-appearance'
import {
  addTqTaskStatus,
  createAlertTask,
  TQ_ORIGINAL_CONTENT_KEY,
} from '#plugins/tq/alert-task'
import { type TqClient } from '#plugins/tq/tq-client'
import {
  SlackApiError,
  type SlackMessageMetadata,
  type SlackNotifier,
} from '#slack'
import type { SentryIssueAlertEvent } from '#sources/sentry/handlers/issue-alert'
import {
  buildIssueAlertNotification,
  extractIssueAlertInput,
} from '#sources/sentry/handlers/issue-alert'
import {
  extractIssueStateChange,
  readSentryIssueId,
} from '#sources/sentry/handlers/issue-state'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  notifier: SlackNotifier
  tqClient: TqClient
  tqWebUrl: string
}

interface ParsedEvent {
  resource: string
  payload: unknown
}

const hasAction = (
  payload: unknown,
  action: string,
): payload is { action: string } =>
  typeof payload === 'object' &&
  payload !== null &&
  'action' in payload &&
  payload.action === action

const dispatchIssueStateChange = (
  ctx: DispatchContext,
  payload: unknown,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const stateChange = extractIssueStateChange(payload)
  if (stateChange === null) return okAsync('ignored')

  return ctx.notifier
    .findMessagesByMetadata(
      'alert_task',
      (eventPayload) => eventPayload['sentry_issue_id'] === stateChange.issueId,
    )
    .andThen((existingMessages) => {
      interface UpdateState {
        updatedCount: number
        errors: SlackApiError[]
      }

      const updateState = existingMessages.reduce<
        ResultAsync<UpdateState, never>
      >(
        (result, existing) =>
          result.andThen((state) => {
            if (existing.content === undefined) return okAsync(state)

            const isFolded =
              existing.eventPayload[TQ_ORIGINAL_CONTENT_KEY] !== undefined
            if (isFolded === stateChange.resolved) return okAsync(state)

            const updatedContent = setSourceAlertResolved(
              existing.content,
              stateChange.resolved,
            )
            if (updatedContent === existing.content) return okAsync(state)

            return ctx.notifier
              .updateMessage(existing.ref, updatedContent)
              .map(() => ({
                updatedCount: state.updatedCount + 1,
                errors: state.errors,
              }))
              .orElse((error) =>
                okAsync({
                  updatedCount: state.updatedCount,
                  errors: [...state.errors, error],
                }),
              )
          }),
        okAsync<UpdateState>({ updatedCount: 0, errors: [] }),
      )

      return updateState.andThen(
        ({
          updatedCount,
          errors,
        }): ResultAsync<DispatchOutcome, SlackApiError> =>
          errors.length > 0
            ? errAsync(
                new SlackApiError(
                  `failed to update ${String(errors.length)} Sentry issue notifications`,
                  new AggregateError(
                    errors,
                    'Sentry issue notification update failures',
                  ),
                ),
              )
            : okAsync(updatedCount === 0 ? 'ignored' : 'notified'),
      )
    })
}

export const dispatch = (
  ctx: DispatchContext,
  parsed: ParsedEvent,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  if (parsed.resource === 'issue') {
    return dispatchIssueStateChange(ctx, parsed.payload)
  }
  if (parsed.resource !== 'event_alert') return okAsync('ignored')
  if (!hasAction(parsed.payload, 'triggered')) return okAsync('ignored')

  const typed = parsed.payload as SentryIssueAlertEvent
  const note = buildIssueAlertNotification(extractIssueAlertInput(typed))
  if (note === null) return okAsync('ignored')
  const issueId = readSentryIssueId(typed)

  return createAlertTask(ctx.tqClient, note.task, {
    delivery_id: ctx.deliveryId,
    event: 'sentry_issue_alert',
    url: note.webUrl,
  })
    .andThen((task) =>
      ctx.notifier.postMessage(
        addTqTaskStatus(
          note.content,
          task,
          ctx.tqWebUrl,
          issueId === null
            ? undefined
            : ({
                event_type: 'alert_task',
                event_payload: {
                  sentry_issue_id: issueId,
                  ...(task === null ? {} : { task_id: task.id }),
                },
              } satisfies SlackMessageMetadata),
        ),
      ),
    )
    .map((): DispatchOutcome => {
      logger.info(
        {
          delivery_id: ctx.deliveryId,
          event: 'sentry_issue_alert',
          title: note.title,
          level: note.level,
          url: note.webUrl,
        },
        'slack_notified',
      )
      return 'notified'
    })
}
