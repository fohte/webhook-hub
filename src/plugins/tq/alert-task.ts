import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { TqClient, TqTaskRef } from '#plugins/tq/tq-client'
import type {
  SlackBlock,
  SlackMessageContent,
  SlackMessageMetadata,
} from '#slack'

const TQ_TASK_CREATION_FAILURE_FINGERPRINT =
  'webhook-hub.tq-task-creation-failed'

export interface TqTaskStatusInfo {
  task: TqTaskRef
  status: 'todo' | 'completed'
  statusReason: 'completed' | 'not_planned' | 'duplicate' | null
  duplicateOfTask?: Pick<TqTaskRef, 'id' | 'number'>
}

export type TqTaskStatusState = Omit<TqTaskStatusInfo, 'task'>

const TQ_STATUS_PREFIX = '*状態*\n'

const isTqStatusLine = (line: string): boolean =>
  /^(未対応|対応済み|対応不要|重複)(?:\s|$)/.test(line)

const replaceTqStatusLine = (text: string, status: string): string => {
  const newline = text.lastIndexOf('\n')
  const finalLine = text.slice(newline + 1)
  if (isTqStatusLine(finalLine)) return `${text.slice(0, newline + 1)}${status}`
  return text === '' ? status : `${text}\n${status}`
}

const isTqStatusElement = (
  element: unknown,
): element is { type: 'mrkdwn'; text: string } =>
  typeof element === 'object' &&
  element !== null &&
  'type' in element &&
  element.type === 'mrkdwn' &&
  'text' in element &&
  typeof element.text === 'string' &&
  element.text.startsWith(TQ_STATUS_PREFIX)

const hasTqStatusBlock = (block: SlackBlock): boolean =>
  block.type === 'context' && block.elements.some(isTqStatusElement)

export const readTqTaskStatusState = (
  eventPayload: Record<string, unknown> | undefined,
): TqTaskStatusState | null => {
  const status = eventPayload?.['tq_task_status']
  const reason = eventPayload?.['tq_task_status_reason']
  if (status !== 'todo' && status !== 'completed') return null
  if (
    reason !== undefined &&
    reason !== 'none' &&
    reason !== 'completed' &&
    reason !== 'not_planned' &&
    reason !== 'duplicate'
  ) {
    return null
  }

  const statusReason = reason === 'none' || reason === undefined ? null : reason
  if (status === 'todo' && statusReason !== null) return null

  const duplicateId = eventPayload?.['tq_duplicate_task_id']
  const duplicateNumber = eventPayload?.['tq_duplicate_task_number']
  return {
    status,
    statusReason,
    ...(typeof duplicateId === 'string' && typeof duplicateNumber === 'number'
      ? { duplicateOfTask: { id: duplicateId, number: duplicateNumber } }
      : {}),
  }
}

export const updateTqTaskStatus = (
  content: SlackMessageContent,
  status: string,
  info?: TqTaskStatusInfo,
): SlackMessageContent => {
  const originalBlocks = content.blocks ?? []
  const blocks = originalBlocks.some(hasTqStatusBlock)
    ? originalBlocks.map((block) => {
        if (block.type !== 'context') return block
        return {
          ...block,
          elements: block.elements.map((element) =>
            isTqStatusElement(element)
              ? { ...element, text: `${TQ_STATUS_PREFIX}${status}` }
              : element,
          ),
        }
      })
    : [
        ...originalBlocks,
        {
          type: 'context' as const,
          elements: [
            { type: 'mrkdwn' as const, text: `${TQ_STATUS_PREFIX}${status}` },
          ],
        },
      ]

  const metadata = content.metadata
  let updatedMetadata = metadata
  if (metadata !== undefined && info !== undefined) {
    const eventPayload = { ...metadata.event_payload }
    delete eventPayload['tq_duplicate_task_id']
    delete eventPayload['tq_duplicate_task_number']
    eventPayload['tq_task_status'] = info.status
    eventPayload['tq_task_status_reason'] = info.statusReason ?? 'none'
    if (info.duplicateOfTask !== undefined) {
      eventPayload['tq_duplicate_task_id'] = info.duplicateOfTask.id
      eventPayload['tq_duplicate_task_number'] = info.duplicateOfTask.number
    }
    updatedMetadata = { ...metadata, event_payload: eventPayload }
  }

  return {
    ...content,
    text: replaceTqStatusLine(content.text, status),
    blocks,
    ...(updatedMetadata === undefined ? {} : { metadata: updatedMetadata }),
  }
}

export const formatTqTaskStatus = (
  info: TqTaskStatusInfo,
  tqWebUrl: string,
): string => {
  const baseUrl = tqWebUrl.replace(/\/+$/, '')
  const taskLink = `<${baseUrl}/tasks/${info.task.id}|tq #${String(info.task.number)}>`
  const state =
    info.status === 'todo'
      ? '未対応'
      : info.statusReason === 'not_planned'
        ? '対応不要'
        : info.statusReason === 'duplicate'
          ? '重複'
          : '対応済み'
  const duplicateLink =
    info.status === 'completed' &&
    info.statusReason === 'duplicate' &&
    info.duplicateOfTask !== undefined
      ? ` → <${baseUrl}/tasks/${info.duplicateOfTask.id}|tq #${String(info.duplicateOfTask.number)}>`
      : ''

  return `${state} · ${taskLink}${duplicateLink}`
}

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
  previousStatus?: TqTaskStatusState | null,
): SlackMessageContent => {
  const taskStatusInfo =
    task === null
      ? undefined
      : {
          task,
          ...(previousStatus ?? {
            status: 'todo' as const,
            statusReason: null,
          }),
        }
  const status =
    taskStatusInfo === undefined
      ? '未対応'
      : formatTqTaskStatus(taskStatusInfo, tqWebUrl)
  const resolvedMetadata =
    metadata ??
    (task === null
      ? undefined
      : {
          event_type: 'alert_task',
          event_payload: { task_id: task.id },
        })

  return updateTqTaskStatus(
    {
      ...content,
      ...(resolvedMetadata === undefined ? {} : { metadata: resolvedMetadata }),
    },
    status,
    taskStatusInfo,
  )
}
