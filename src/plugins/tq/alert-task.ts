import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { okAsync, type ResultAsync } from 'neverthrow'

import { logger } from '#logger'
import {
  decodeOriginalContent,
  replacePrimaryContent,
  TQ_ORIGINAL_CONTENT_KEY,
  type TqOriginalContent,
  withoutOriginalContentSnapshot,
} from '#plugins/tq/alert-task-snapshot'
import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { TqClient, TqTaskRef } from '#plugins/tq/tq-client'
import type {
  SlackBlock,
  SlackMessageContent,
  SlackMessageMetadata,
} from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { TODO_ALERT_COLOR } from '#sources/alert-colors'

export { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task-snapshot'

const COMPLETED_TQ_COLOR = '#8250df'
const DISMISSED_TQ_COLOR = '#6b6e75'
const TODO_TQ_COLOR = '#2eb67d'
const TQ_TASK_CREATION_FAILURE_FINGERPRINT =
  'webhook-hub.tq-task-creation-failed'

type TqTaskStatusAttachment = Pick<
  SlackMessageContent,
  'text' | 'color' | 'blocks'
>

export interface TqTaskStatusInfo {
  task: TqTaskRef
  status: 'todo' | 'completed'
  statusReason: 'completed' | 'not_planned' | 'duplicate' | null
  duplicateOfTask?: Pick<TqTaskRef, 'id' | 'number'> & { title?: string }
  occurredAt?: string
}

export type TqTaskStatusState = Omit<TqTaskStatusInfo, 'task'>

const isLegacyStatusLine = (line: string): boolean =>
  /^(未対応|対応済み|対応不要|重複)(?:\s|$)/.test(line)

const removeLegacyStatusLine = (text: string): string => {
  const newline = text.lastIndexOf('\n')
  const finalLine = text.slice(newline + 1)
  return isLegacyStatusLine(finalLine)
    ? newline === -1
      ? ''
      : text.slice(0, newline)
    : text
}

const isLegacyCompactedAppearance = (content: SlackMessageContent): boolean => {
  const heading = content.blocks?.[0]
  return (
    heading?.type === 'section' &&
    heading.text?.type === 'mrkdwn' &&
    /^\*(?:✅|⏭️|🔁) ~/u.test(heading.text.text)
  )
}

const isLegacyStatusText = (text: string): boolean =>
  text.startsWith('*状態*\n') || isLegacyStatusLine(text)

const restoreLegacyCompactedHeading = (
  heading: string,
  metadata: SlackMessageMetadata | undefined,
): string => {
  const title = /^\*(?:✅|⏭️|🔁) ~([\s\S]*)~\*$/u.exec(heading)?.[1]
  if (title === undefined) return heading
  const icon = metadata?.event_type === 'grafana_alert' ? '🔥' : '🚨'
  return `*${icon} ${title}*`
}

const removeLegacyStatus = (
  content: SlackMessageContent,
): TqOriginalContent => {
  const compacted = isLegacyCompactedAppearance(content)
  const metadata = content.metadata
  const blocks: SlackBlock[] | undefined = content.blocks?.flatMap<SlackBlock>(
    (block, index) => {
      if (
        block.type === 'section' &&
        compacted &&
        index === 0 &&
        block.text?.type === 'mrkdwn'
      ) {
        return [
          {
            ...block,
            text: {
              ...block.text,
              text: restoreLegacyCompactedHeading(block.text.text, metadata),
            },
          },
        ]
      }
      if (block.type !== 'context') return [block]
      const elements = block.elements.filter(
        (element) =>
          element.type !== 'mrkdwn' || !isLegacyStatusText(element.text),
      )
      return elements.length === 0 ? [] : [{ ...block, elements }]
    },
  )
  const lines = removeLegacyStatusLine(content.text).split('\n')
  const heading = content.blocks?.[0]
  if (
    compacted &&
    heading?.type === 'section' &&
    heading.text?.type === 'mrkdwn'
  ) {
    lines[0] = restoreLegacyCompactedHeading(heading.text.text, metadata)
  }
  return {
    text: lines.join('\n'),
    ...(compacted
      ? { color: TODO_ALERT_COLOR }
      : content.color === undefined
        ? {}
        : { color: content.color }),
    ...(blocks === undefined ? {} : { blocks }),
  }
}

const restoreLegacyCompactedContent = (
  content: SlackMessageContent,
): {
  content: TqOriginalContent
  metadata?: SlackMessageMetadata
} => {
  const metadata = content.metadata
  const snapshot = metadata?.event_payload[TQ_ORIGINAL_CONTENT_KEY]
  const compacted = isLegacyCompactedAppearance(content)
  if (metadata !== undefined && compacted && snapshot === undefined) {
    logger.warn(
      { task_id: metadata.event_payload['task_id'] },
      'tq_original_content_snapshot_missing',
    )
  }
  if (metadata === undefined || !compacted || snapshot === undefined) {
    return { content: removeLegacyStatus(content) }
  }

  const decoded = decodeOriginalContent(snapshot)
  if (decoded === null) {
    logger.warn(
      { task_id: metadata.event_payload['task_id'] },
      'tq_original_content_decode_failed',
    )
    return {
      content: removeLegacyStatus(content),
      metadata: {
        ...metadata,
        event_payload: withoutOriginalContentSnapshot(metadata.event_payload),
      },
    }
  }

  return {
    content: decoded,
    metadata: {
      ...metadata,
      event_payload: withoutOriginalContentSnapshot(metadata.event_payload),
    },
  }
}

const toSlackTimestamp = (occurredAt: string | undefined): string | null => {
  if (occurredAt === undefined) return null
  const date = new Date(occurredAt)
  const timestamp = date.getTime()
  if (Number.isNaN(timestamp)) return null

  const seconds = Math.floor(timestamp / 1000)
  const fallback = date
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d{2}\.\d{3}Z$/u, ' UTC')
  return `<!date^${String(seconds)}^{date_short} {time}|${fallback}>`
}

const statusColor = (info: TqTaskStatusInfo | undefined): string =>
  info?.status !== 'completed'
    ? TODO_TQ_COLOR
    : info.statusReason === 'not_planned' || info.statusReason === 'duplicate'
      ? DISMISSED_TQ_COLOR
      : COMPLETED_TQ_COLOR

const tqStatusAttachment = (
  status: string,
  info: TqTaskStatusInfo | undefined,
): TqTaskStatusAttachment => ({
  text: status,
  color: statusColor(info),
  blocks: [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: status }],
    },
  ],
})

const updateTaskStatusMetadata = (
  metadata: SlackMessageMetadata,
  info: TqTaskStatusInfo,
): SlackMessageMetadata => {
  const eventPayload = { ...metadata.event_payload }
  delete eventPayload['tq_duplicate_task_id']
  delete eventPayload['tq_duplicate_task_number']
  delete eventPayload['tq_duplicate_task_title']
  delete eventPayload['tq_task_occurred_at']
  eventPayload['tq_task_status'] = info.status
  eventPayload['tq_task_status_reason'] = info.statusReason ?? 'none'
  if (info.status === 'completed' && info.occurredAt !== undefined) {
    eventPayload['tq_task_occurred_at'] = info.occurredAt
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
  const occurredAt = eventPayload?.['tq_task_occurred_at']
  return {
    status,
    statusReason,
    ...(status === 'completed' && typeof occurredAt === 'string'
      ? { occurredAt }
      : {}),
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

export const updateTqTaskStatus = (
  content: SlackMessageContent,
  status: string,
  info?: TqTaskStatusInfo,
): SlackMessageContent => {
  const legacy = restoreLegacyCompactedContent(content)
  const metadata =
    content.metadata === undefined || info === undefined
      ? (legacy.metadata ?? content.metadata)
      : updateTaskStatusMetadata(legacy.metadata ?? content.metadata, info)
  const additionalAttachments = content.additionalAttachments ?? []
  const statusAttachment = tqStatusAttachment(status, info)
  return {
    ...replacePrimaryContent(content, legacy.content),
    additionalAttachments: [
      ...additionalAttachments.slice(0, -1),
      statusAttachment,
    ],
    ...(metadata === undefined ? {} : { metadata }),
  }
}

export const formatTqTaskStatus = (
  info: TqTaskStatusInfo,
  tqWebUrl: string,
): string => {
  const baseUrl = tqWebUrl.replace(/\/+$/, '')
  const taskLink = `<${baseUrl}/tasks/${info.task.id}|tq #${String(info.task.number)}>`
  if (info.status === 'todo') return `${taskLink} · todo`

  const struckTaskLink = `~${taskLink}~`
  if (info.statusReason === 'duplicate') {
    const duplicate = info.duplicateOfTask
    return duplicate === undefined
      ? `${struckTaskLink} · duplicate`
      : `${struckTaskLink} · duplicate of #${String(duplicate.number)}${duplicate.title === undefined ? '' : ` ${escapeSlackMrkdwn(duplicate.title)}`}`
  }

  const state =
    info.statusReason === 'not_planned' ? 'not planned' : 'completed'
  const timestamp = toSlackTimestamp(info.occurredAt)
  return `${struckTaskLink} · ${state}${timestamp === null ? '' : ` ${timestamp}`}`
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
