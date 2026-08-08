import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import type { SlackApiError, SlackNotifier } from '#slack'
import type { SentryIssueAlertEvent } from '#sources/sentry/handlers/issue-alert'
import {
  buildIssueAlertNotification,
  extractIssueAlertInput,
} from '#sources/sentry/handlers/issue-alert'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  notifier: SlackNotifier
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

// Sentry defines no extra filter stage beyond recognizing a triggered
// event_alert, so both branches below return "ignored" rather than
// "filtered" — there is nothing recognized-but-excluded to distinguish.
export const dispatch = (
  ctx: DispatchContext,
  parsed: ParsedEvent,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  if (parsed.resource !== 'event_alert') return okAsync('ignored')
  if (!hasAction(parsed.payload, 'triggered')) return okAsync('ignored')

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload shape refinement
  const typed = parsed.payload as SentryIssueAlertEvent
  const note = buildIssueAlertNotification(extractIssueAlertInput(typed))
  if (note === null) return okAsync('ignored')

  return ctx.notifier
    .postMessage({ text: note.text })
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
