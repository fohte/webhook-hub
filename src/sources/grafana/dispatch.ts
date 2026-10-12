import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import { addTqTaskStatus, createAlertTask } from '#plugins/tq/alert-task'
import { type TqClient, type TqTaskRef } from '#plugins/tq/tq-client'
import type { SlackApiError, SlackMessageMetadata, SlackNotifier } from '#slack'
import {
  buildGrafanaAlertNotification,
  type GrafanaAlert,
} from '#sources/grafana/handlers/alert'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  eventName: string
  notifier: SlackNotifier
  tqClient: TqClient
  tqWebUrl: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === 'string')

const isOptionalString = (
  value: Record<string, unknown>,
  key: string,
): boolean => value[key] === undefined || typeof value[key] === 'string'

const isGrafanaAlert = (value: unknown): value is GrafanaAlert =>
  isRecord(value) &&
  (value['status'] === 'firing' || value['status'] === 'resolved') &&
  isStringRecord(value['labels']) &&
  isStringRecord(value['annotations']) &&
  typeof value['fingerprint'] === 'string' &&
  value['fingerprint'] !== '' &&
  isOptionalString(value, 'startsAt') &&
  isOptionalString(value, 'endsAt') &&
  isOptionalString(value, 'generatorURL') &&
  isOptionalString(value, 'dashboardURL') &&
  isOptionalString(value, 'panelURL')

const extractAlerts = (payload: unknown): GrafanaAlert[] => {
  if (!isRecord(payload) || !Array.isArray(payload['alerts'])) return []
  return payload['alerts'].filter(isGrafanaAlert)
}

const readTaskRef = (payload: Record<string, unknown>): TqTaskRef | null => {
  const id = payload['task_id']
  const number = payload['task_number']
  return typeof id === 'string' && typeof number === 'number'
    ? { id, number }
    : null
}

const buildMetadata = (
  fingerprint: string,
  task: TqTaskRef | null,
): SlackMessageMetadata => ({
  event_type: 'grafana_alert',
  event_payload: {
    fingerprint,
    ...(task === null ? {} : { task_id: task.id, task_number: task.number }),
  },
})

const dispatchAlert = (
  ctx: DispatchContext,
  alert: GrafanaAlert,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const note = buildGrafanaAlertNotification(alert)

  return ctx.notifier
    .findMessageByMetadata(
      'grafana_alert',
      (payload) => payload['fingerprint'] === alert.fingerprint,
    )
    .andThen((existing) => {
      const createOrReuseTask =
        existing === null
          ? createAlertTask(ctx.tqClient, note.task, {
              delivery_id: ctx.deliveryId,
              event: ctx.eventName,
              fingerprint: alert.fingerprint,
            })
          : okAsync(readTaskRef(existing.eventPayload))

      return createOrReuseTask.andThen((task) => {
        const content = addTqTaskStatus(
          note.content,
          task,
          ctx.tqWebUrl,
          buildMetadata(alert.fingerprint, task),
        )
        const notification =
          existing === null
            ? ctx.notifier.postMessage(content).map(() => undefined)
            : ctx.notifier.updateMessage(existing.ref, content)

        return notification.map((): DispatchOutcome => {
          logger.info(
            {
              delivery_id: ctx.deliveryId,
              event: ctx.eventName,
              fingerprint: alert.fingerprint,
              title: note.alertName,
              status: note.status,
            },
            'slack_notified',
          )
          return 'notified'
        })
      })
    })
}

export const dispatch = (
  ctx: DispatchContext,
  payload: unknown,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const alerts = extractAlerts(payload)
  if (alerts.length === 0) return okAsync('ignored')

  return alerts.reduce<ResultAsync<DispatchOutcome, SlackApiError>>(
    (result, alert) =>
      result.andThen((previous) =>
        dispatchAlert(ctx, alert).map((current) =>
          previous === 'notified' || current === 'notified'
            ? 'notified'
            : current,
        ),
      ),
    okAsync('ignored'),
  )
}
