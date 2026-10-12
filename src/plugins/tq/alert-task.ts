import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { TqClient, TqTaskRef } from '#plugins/tq/tq-client'
import type { SlackMessageContent, SlackMessageMetadata } from '#slack'

const TQ_TASK_CREATION_FAILURE_FINGERPRINT =
  'webhook-hub.tq-task-creation-failed'

export const createAlertTask = (
  tqClient: TqClient,
  request: CreateTaskRequest,
  extras: Record<string, unknown>,
): ResultAsync<TqTaskRef | null, never> =>
  tqClient.createTask(request).orElse((error) => {
    captureWithFingerprint(error, TQ_TASK_CREATION_FAILURE_FINGERPRINT, {
      extras,
    })
    logger.warn({ err: error, ...extras }, 'tq_task_creation_failed')
    return okAsync(null)
  })

export const addTqTaskStatus = (
  content: SlackMessageContent,
  task: TqTaskRef | null,
  tqWebUrl: string,
  metadata?: SlackMessageMetadata,
): SlackMessageContent => {
  const taskLink =
    task === null
      ? null
      : `<${tqWebUrl.replace(/\/+$/, '')}/tasks/${task.id}|tq #${String(task.number)}>`
  const status = `未対応${taskLink === null ? '' : ` · ${taskLink}`}`
  const resolvedMetadata =
    metadata ??
    (task === null
      ? undefined
      : {
          event_type: 'alert_task',
          event_payload: { task_id: task.id },
        })
  const statusBlock = {
    type: 'context' as const,
    elements: [{ type: 'mrkdwn' as const, text: `*状態*\n${status}` }],
  }

  return {
    ...content,
    text: `${content.text}\n${status}`,
    blocks: [...(content.blocks ?? []), statusBlock],
    ...(resolvedMetadata === undefined ? {} : { metadata: resolvedMetadata }),
  }
}
