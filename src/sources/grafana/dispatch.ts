import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from 'neverthrow'

import { logger } from '#logger'
import {
  addTqTaskStatus,
  createAlertTask,
  readTqTaskStatusState,
} from '#plugins/tq/alert-task'
import { type TqClient, type TqTaskRef } from '#plugins/tq/tq-client'
import {
  SlackApiError,
  type SlackHistorySearchOptions,
  type SlackMessageContent,
  type SlackMessageMetadata,
  type SlackNotifier,
} from '#slack'
import {
  buildGrafanaAlertNotification,
  type GrafanaAlert,
} from '#sources/grafana/handlers/alert'
import {
  type GrafanaPanelImageRenderer,
  readPanelId,
} from '#sources/grafana/panel-image'
import type { DispatchOutcome } from '#webhook-source'

export interface DispatchContext {
  deliveryId: string
  eventName: string
  notifier: SlackNotifier
  panelImageRenderer?: GrafanaPanelImageRenderer
  tqClient: TqClient
  tqWebUrl: string
}

const alertDispatchLocks = new WeakMap<
  SlackNotifier,
  Map<string, Promise<void>>
>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === 'string')

const isOptionalString = (
  value: Record<string, unknown>,
  key: string,
): boolean => value[key] === undefined || typeof value[key] === 'string'

const isTimestampString = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const isGrafanaAlert = (value: unknown): value is GrafanaAlert =>
  isRecord(value) &&
  (value['status'] === 'firing' || value['status'] === 'resolved') &&
  isStringRecord(value['labels']) &&
  isStringRecord(value['annotations']) &&
  typeof value['fingerprint'] === 'string' &&
  value['fingerprint'] !== '' &&
  isTimestampString(value['startsAt']) &&
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
  alert: GrafanaAlert,
  task: TqTaskRef | null,
): SlackMessageMetadata => ({
  event_type: 'grafana_alert',
  event_payload: {
    fingerprint: alert.fingerprint,
    starts_at: alert.startsAt,
    grafana_status: alert.status,
    ...(task === null ? {} : { task_id: task.id, task_number: task.number }),
  },
})

const readPanelImageFileId = (
  eventPayload: Record<string, unknown> | undefined,
): string | undefined => {
  const fileId = eventPayload?.['panel_image_file_id']
  return typeof fileId === 'string' && fileId !== '' ? fileId : undefined
}

const historySearchOptions = (startsAt: string): SlackHistorySearchOptions => {
  const timestamp = Date.parse(startsAt)
  if (!Number.isFinite(timestamp)) return { maxPages: 5 }

  const startSecond = Math.floor(timestamp / 1000)
  return {
    oldest: String(Math.max(0, startSecond - 86_400)),
    latest: String(startSecond + 86_400),
    maxPages: 5,
  }
}

const reportPanelImageFailure = (
  alert: GrafanaAlert,
  error: Error,
  phase: 'render' | 'upload' | 'post' | 'update',
): void => {
  logger.warn(
    {
      fingerprint: alert.fingerprint,
      panel_id: readPanelId(alert),
      phase,
      err: error,
    },
    'grafana_panel_image_failed',
  )
}

const addPanelImage = (
  ctx: DispatchContext,
  alert: GrafanaAlert,
  content: SlackMessageContent,
  existingPanelImageFileId?: string,
): ResultAsync<typeof content, never> => {
  const addImageBlock = (
    fileId: string,
    panelId: string,
  ): SlackMessageContent => ({
    ...content,
    ...(content.metadata === undefined
      ? {}
      : {
          metadata: {
            ...content.metadata,
            event_payload: {
              ...content.metadata.event_payload,
              panel_image_file_id: fileId,
            },
          },
        }),
    blocks: [
      ...(content.blocks ?? []),
      {
        type: 'image' as const,
        slack_file: { id: fileId },
        alt_text: `Grafana panel ${panelId}`,
      },
    ],
  })

  if (existingPanelImageFileId !== undefined) {
    return okAsync(
      addImageBlock(existingPanelImageFileId, readPanelId(alert) ?? 'image'),
    )
  }

  const renderer = ctx.panelImageRenderer
  if (renderer === undefined) return okAsync(content)

  return renderer
    .render(alert)
    .andThen((image) =>
      ctx.notifier
        .uploadImage({
          data: image.buffer,
          filename: `grafana-panel-${image.panelId}.png`,
          altText: `Grafana panel ${image.panelId}`,
        })
        .map((fileId) => addImageBlock(fileId, image.panelId))
        .orElse((error) => {
          reportPanelImageFailure(alert, error, 'upload')
          return okAsync(content)
        }),
    )
    .orElse((error) => {
      reportPanelImageFailure(alert, error, 'render')
      return okAsync(content)
    })
}

const dispatchAlert = (
  ctx: DispatchContext,
  alert: GrafanaAlert,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const note = buildGrafanaAlertNotification(alert)

  return ctx.notifier
    .findMessageByMetadata(
      'grafana_alert',
      (payload) =>
        payload['fingerprint'] === alert.fingerprint &&
        payload['starts_at'] === alert.startsAt,
      historySearchOptions(alert.startsAt),
    )
    .andThen((existing) => {
      const createOrReuseTask =
        existing === null
          ? createAlertTask(ctx.tqClient, note.task, {
              delivery_id: ctx.deliveryId,
              event: ctx.eventName,
              fingerprint: alert.fingerprint,
              starts_at: alert.startsAt,
            })
          : okAsync(readTaskRef(existing.eventPayload))

      return createOrReuseTask.andThen((task) => {
        const panelImageFileId = readPanelImageFileId(
          existing === null ? undefined : existing.eventPayload,
        )
        const metadata = buildMetadata(alert, task)
        const previousStatus = readTqTaskStatusState(
          existing === null ? undefined : existing.eventPayload,
        )
        const baseContent = { ...note.content, metadata }
        const withTaskStatus = (content: SlackMessageContent) =>
          addTqTaskStatus(
            content,
            task,
            ctx.tqWebUrl,
            content.metadata,
            previousStatus,
          )
        const contentWithoutPanelImage = withTaskStatus(baseContent)
        return addPanelImage(ctx, alert, baseContent, panelImageFileId).andThen(
          (contentWithImage) => {
            const notificationContent = withTaskStatus(contentWithImage)
            const notify = (messageContent: SlackMessageContent) =>
              existing === null
                ? ctx.notifier.postMessage(messageContent).map(() => undefined)
                : ctx.notifier.updateMessage(existing.ref, messageContent)

            const notification = notify(notificationContent).orElse((error) => {
              const attachedFileId = readPanelImageFileId(
                notificationContent.metadata?.event_payload,
              )
              if (attachedFileId === undefined) return errAsync(error)

              reportPanelImageFailure(
                alert,
                error,
                existing === null ? 'post' : 'update',
              )
              return notify(contentWithoutPanelImage)
            })

            return notification.map((): DispatchOutcome => {
              logger.info(
                {
                  delivery_id: ctx.deliveryId,
                  event: ctx.eventName,
                  fingerprint: alert.fingerprint,
                  starts_at: alert.startsAt,
                  title: note.alertName,
                  status: note.status,
                },
                'slack_notified',
              )
              return 'notified'
            })
          },
        )
      })
    })
}

const dispatchAlertWithLock = (
  ctx: DispatchContext,
  alert: GrafanaAlert,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const locks =
    alertDispatchLocks.get(ctx.notifier) ?? new Map<string, Promise<void>>()
  alertDispatchLocks.set(ctx.notifier, locks)

  const key = JSON.stringify([alert.fingerprint, alert.startsAt])
  const previous = locks.get(key) ?? Promise.resolve()
  let release = () => {}
  const lock = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(key, lock)

  const finish = (): void => {
    if (locks.get(key) === lock) {
      locks.delete(key)
      if (locks.size === 0) alertDispatchLocks.delete(ctx.notifier)
    }
    release()
  }

  const queuedDispatch: Promise<Result<DispatchOutcome, SlackApiError>> =
    previous.then(async () => await dispatchAlert(ctx, alert))

  return ResultAsync.fromPromise(
    queuedDispatch,
    (caughtErr) =>
      new SlackApiError('failed to dispatch Grafana alert', caughtErr),
  )
    .andThen((result) => result)
    .map((outcome) => {
      finish()
      return outcome
    })
    .mapErr((error) => {
      finish()
      return error
    })
}

export const dispatch = (
  ctx: DispatchContext,
  payload: unknown,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const alerts = extractAlerts(payload)
  if (alerts.length === 0) return okAsync('ignored')

  const dispatchAlerts = async (): Promise<
    Result<DispatchOutcome, SlackApiError>
  > => {
    let notified = false
    let firstError: SlackApiError | null = null

    for (const alert of alerts) {
      const result = await dispatchAlertWithLock(ctx, alert)
      if (result.isErr()) {
        firstError ??= result.error
      } else if (result.value === 'notified') {
        notified = true
      }
    }

    return firstError === null
      ? ok(notified ? 'notified' : 'ignored')
      : err(firstError)
  }

  return ResultAsync.fromPromise(
    dispatchAlerts(),
    (caughtErr) =>
      new SlackApiError('failed to dispatch Grafana alerts', caughtErr),
  ).andThen((result) => result)
}
