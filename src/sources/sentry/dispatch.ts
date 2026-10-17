import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import { setSourceAlertResolved } from '#plugins/tq/alert-source-appearance'
import { addTqTaskStatus, createAlertTask } from '#plugins/tq/alert-task'
import { type TqClient } from '#plugins/tq/tq-client'
import type { SlackApiError, SlackMessageMetadata, SlackNotifier } from '#slack'
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
    .andThen((existingMessages) =>
      existingMessages.reduce<ResultAsync<DispatchOutcome, SlackApiError>>(
        (result, existing) =>
          result.andThen((outcome) => {
            if (existing.content === undefined) {
              return okAsync<DispatchOutcome>(outcome)
            }

            return ctx.notifier
              .updateMessage(
                existing.ref,
                setSourceAlertResolved(existing.content, stateChange.resolved),
              )
              .map((): DispatchOutcome => 'notified')
          }),
        okAsync<DispatchOutcome>('ignored'),
      ),
    )
}

// Sentry defines no extra filter stage beyond recognizing a triggered
// event_alert, so both branches below return "ignored" rather than
// "filtered" — there is nothing recognized-but-excluded to distinguish.
export const dispatch = (
  ctx: DispatchContext,
  parsed: ParsedEvent,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  if (parsed.resource === 'issue') {
    return dispatchIssueStateChange(ctx, parsed.payload)
  }
  if (parsed.resource !== 'event_alert') return okAsync('ignored')
  if (!hasAction(parsed.payload, 'triggered')) return okAsync('ignored')

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape refinement
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
