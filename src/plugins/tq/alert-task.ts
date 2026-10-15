import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import {
  compactAppearance,
  isCompactedAppearance,
  readGrafanaStatus,
} from '#plugins/tq/alert-task-appearance'
import {
  decodeOriginalContent,
  encodeOriginalContent,
  isWithinSlackMetadataSizeLimit,
  TQ_ORIGINAL_CONTENT_KEY,
  type TqOriginalContent,
} from '#plugins/tq/alert-task-snapshot'
import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { TqClient, TqTaskRef } from '#plugins/tq/tq-client'
import {
  type SlackBlock,
  type SlackMessageContent,
  type SlackMessageMetadata,
} from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { ALERT_FIELD_LABELS } from '#sources/alert-field-labels'

export { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task-snapshot'

const TQ_TASK_CREATION_FAILURE_FINGERPRINT =
  'webhook-hub.tq-task-creation-failed'

export interface TqTaskStatusInfo {
  task: TqTaskRef
  status: 'todo' | 'completed'
  statusReason: 'completed' | 'not_planned' | 'duplicate' | null
  duplicateOfTask?: Pick<TqTaskRef, 'id' | 'number'> & { title?: string }
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

const removeTqStatusLine = (text: string): string => {
  const newline = text.lastIndexOf('\n')
  const finalLine = text.slice(newline + 1)
  return isTqStatusLine(finalLine)
    ? newline === -1
      ? ''
      : text.slice(0, newline)
    : text
}

const stripTqStatus = (content: SlackMessageContent): TqOriginalContent => ({
  text: removeTqStatusLine(content.text),
  ...(content.color === undefined ? {} : { color: content.color }),
  ...(content.blocks === undefined
    ? {}
    : { blocks: content.blocks.filter((block) => !hasTqStatusBlock(block)) }),
})

const addStatusBlock = (blocks: SlackBlock[], status: string): SlackBlock[] => {
  if (blocks.some(hasTqStatusBlock)) {
    return blocks.map((block) =>
      block.type !== 'context'
        ? block
        : {
            ...block,
            elements: block.elements.map((element) =>
              isTqStatusElement(element)
                ? { ...element, text: `${TQ_STATUS_PREFIX}${status}` }
                : element,
            ),
          },
    )
  }

  const statusBlock: SlackBlock = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${TQ_STATUS_PREFIX}${status}` }],
  }
  const firstImageIndex = blocks.findIndex((block) => block.type === 'image')
  return firstImageIndex === -1
    ? [...blocks, statusBlock]
    : [
        ...blocks.slice(0, firstImageIndex),
        statusBlock,
        ...blocks.slice(firstImageIndex),
      ]
}

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
  const duplicateTitle = eventPayload?.['tq_duplicate_task_title']
  return {
    status,
    statusReason,
    ...(typeof duplicateId === 'string' && typeof duplicateNumber === 'number'
      ? {
          duplicateOfTask: {
            id: duplicateId,
            number: duplicateNumber,
            ...(typeof duplicateTitle === 'string'
              ? { title: duplicateTitle }
              : {}),
          },
        }
      : {}),
  }
}

const appendGrafanaStatus = (
  status: string,
  grafanaStatus: 'firing' | 'resolved' | undefined,
): string =>
  grafanaStatus === undefined
    ? status
    : `${status} · ${ALERT_FIELD_LABELS.grafanaStatus}: ${grafanaStatus}`

const restoreTodoColor = (
  content: TqOriginalContent,
  info: TqTaskStatusInfo | undefined,
  metadata: SlackMessageMetadata | undefined,
): TqOriginalContent =>
  info?.status === 'todo' && readGrafanaStatus(metadata, content) === 'resolved'
    ? { ...content, color: '#d73a49' }
    : content

const updateTaskStatusMetadata = (
  metadata: SlackMessageMetadata,
  info: TqTaskStatusInfo,
  snapshot?: string | number | boolean,
): SlackMessageMetadata => {
  const eventPayload = Object.fromEntries(
    Object.entries(metadata.event_payload).filter(
      ([key]) => key !== TQ_ORIGINAL_CONTENT_KEY,
    ),
  )
  delete eventPayload['tq_duplicate_task_id']
  delete eventPayload['tq_duplicate_task_number']
  delete eventPayload['tq_duplicate_task_title']
  eventPayload['tq_task_status'] = info.status
  eventPayload['tq_task_status_reason'] = info.statusReason ?? 'none'
  if (snapshot !== undefined) {
    eventPayload[TQ_ORIGINAL_CONTENT_KEY] = snapshot
  }
  if (info.duplicateOfTask !== undefined) {
    eventPayload['tq_duplicate_task_id'] = info.duplicateOfTask.id
    eventPayload['tq_duplicate_task_number'] = info.duplicateOfTask.number
    if (info.duplicateOfTask.title !== undefined) {
      eventPayload['tq_duplicate_task_title'] = info.duplicateOfTask.title
    }
  }
  return { ...metadata, event_payload: eventPayload }
}

export const updateTqTaskStatus = (
  content: SlackMessageContent,
  status: string,
  info?: TqTaskStatusInfo,
): SlackMessageContent => {
  const metadata = content.metadata
  const storedOriginalSnapshot =
    metadata?.event_payload[TQ_ORIGINAL_CONTENT_KEY]
  const decodedOriginalContent = decodeOriginalContent(storedOriginalSnapshot)
  const statusWithSource = appendGrafanaStatus(
    status,
    readGrafanaStatus(metadata, decodedOriginalContent ?? content),
  )
  const metadataStatus = metadata?.event_payload['tq_task_status']
  const isCorruptSnapshot =
    storedOriginalSnapshot !== undefined && decodedOriginalContent === null
  const isLegacyFoldedContent =
    metadataStatus === 'completed' &&
    decodedOriginalContent === null &&
    isCompactedAppearance(content)

  if (isCorruptSnapshot) {
    logger.warn(
      { task_id: metadata?.event_payload['task_id'] },
      'tq_original_content_decode_failed',
    )
  }

  if (isCorruptSnapshot || isLegacyFoldedContent) {
    if (isLegacyFoldedContent && !isCorruptSnapshot) {
      logger.warn(
        { task_id: metadata?.event_payload['task_id'] },
        'tq_original_content_snapshot_missing',
      )
    }
    const updatedMetadata =
      metadata === undefined || info === undefined
        ? metadata
        : updateTaskStatusMetadata(metadata, info, storedOriginalSnapshot)
    const cannotRecoverFoldedContent =
      isCompactedAppearance(content) &&
      (isCorruptSnapshot || isLegacyFoldedContent)
    const originalContent = restoreTodoColor(
      stripTqStatus(content),
      info,
      metadata,
    )
    const updatedContent = cannotRecoverFoldedContent
      ? content
      : {
          ...originalContent,
          text: replaceTqStatusLine(originalContent.text, statusWithSource),
          blocks: addStatusBlock(
            originalContent.blocks ?? [],
            statusWithSource,
          ),
        }
    return {
      ...content,
      ...updatedContent,
      ...(updatedMetadata === undefined ? {} : { metadata: updatedMetadata }),
    }
  }

  const originalContent = restoreTodoColor(
    decodedOriginalContent ?? stripTqStatus(content),
    info,
    metadata,
  )
  const previousSnapshot =
    typeof storedOriginalSnapshot === 'string' &&
    decodedOriginalContent !== null
      ? storedOriginalSnapshot
      : undefined
  const snapshot =
    info?.status === 'completed'
      ? (previousSnapshot ?? encodeOriginalContent(originalContent))
      : previousSnapshot
  const updatedMetadata =
    metadata === undefined || info === undefined
      ? metadata
      : updateTaskStatusMetadata(
          metadata,
          info,
          info.status === 'completed' ? snapshot : previousSnapshot,
        )
  const snapshotExceedsLimit =
    info?.status === 'completed' &&
    updatedMetadata !== undefined &&
    !isWithinSlackMetadataSizeLimit(updatedMetadata)
  let updatedContent: SlackMessageContent

  if (info?.status === 'completed') {
    if (!snapshotExceedsLimit) {
      updatedContent = compactAppearance(
        originalContent,
        statusWithSource,
        info,
        metadata,
      )
    } else {
      logger.warn(
        {
          task_id: metadata?.event_payload['task_id'],
          metadata_bytes: Buffer.byteLength(
            JSON.stringify(updatedMetadata),
            'utf8',
          ),
        },
        'tq_original_content_snapshot_too_large',
      )
      updatedContent = {
        ...originalContent,
        text: replaceTqStatusLine(originalContent.text, statusWithSource),
        blocks: addStatusBlock(originalContent.blocks ?? [], statusWithSource),
      }
    }
  } else {
    updatedContent = {
      ...originalContent,
      text: replaceTqStatusLine(originalContent.text, statusWithSource),
      blocks: addStatusBlock(originalContent.blocks ?? [], statusWithSource),
    }
  }

  const finalMetadata =
    snapshotExceedsLimit && metadata !== undefined
      ? updateTaskStatusMetadata(metadata, info)
      : updatedMetadata

  return {
    ...content,
    ...updatedContent,
    ...(finalMetadata === undefined ? {} : { metadata: finalMetadata }),
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

  if (info.statusReason === 'duplicate') {
    if (info.duplicateOfTask === undefined) return `${state} · ${taskLink}`
    const duplicateTitle =
      info.duplicateOfTask.title === undefined
        ? ''
        : ` ${escapeSlackMrkdwn(info.duplicateOfTask.title)}`
    const duplicateLink = `<${baseUrl}/tasks/${info.duplicateOfTask.id}|tq #${String(info.duplicateOfTask.number)}${duplicateTitle}>`
    return `${state} · ${taskLink} → ${duplicateLink} で対応`
  }

  return `${state} · ${taskLink}`
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
