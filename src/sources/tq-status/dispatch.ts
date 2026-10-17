import { okAsync, type ResultAsync } from 'neverthrow'

import { formatTqTaskStatus, updateTqTaskStatus } from '#plugins/tq/alert-task'
import { TaskStatusChangedWebhookEvent } from '#plugins/tq/generated/tq-contract'
import type { SlackApiError, SlackNotifier } from '#slack'
import type { DispatchOutcome } from '#webhook-source'

const findAlertMessage = (notifier: SlackNotifier, taskId: string) =>
  notifier.findMessageByMetadata(
    ['alert_task', 'grafana_alert'],
    (payload) => payload['task_id'] === taskId,
  )

export const dispatchTqTaskStatusChanged = (
  notifier: SlackNotifier,
  tqWebUrl: string,
  payload: unknown,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const parsed = TaskStatusChangedWebhookEvent.safeParse(payload)
  if (!parsed.success) return okAsync<DispatchOutcome>('ignored')

  const { task, occurredAt } = parsed.data
  return findAlertMessage(notifier, task.id).andThen((message) => {
    if (message === null || message.content === undefined) {
      return okAsync<DispatchOutcome>('ignored')
    }

    const statusInfo = {
      task: { id: task.id, number: task.number },
      status: task.status,
      statusReason: task.statusReason,
      occurredAt,
      ...(task.duplicateOfTask === undefined
        ? {}
        : { duplicateOfTask: task.duplicateOfTask }),
    }
    const status = formatTqTaskStatus(statusInfo, tqWebUrl)

    return notifier
      .updateMessage(
        message.ref,
        updateTqTaskStatus(message.content, status, statusInfo),
      )
      .map((): DispatchOutcome => 'notified')
  })
}
