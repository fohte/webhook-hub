import { okAsync, type ResultAsync } from 'neverthrow'

import { formatTqTaskStatus } from '#plugins/tq/alert-task'
import { TaskStatusChangedWebhookEvent } from '#plugins/tq/generated/tq-contract'
import type {
  SlackApiError,
  SlackBlock,
  SlackMessageContent,
  SlackNotifier,
} from '#slack'
import type { DispatchOutcome } from '#webhook-source'

const isStatusLine = (line: string): boolean =>
  /^(未対応|対応済み|対応不要|重複)(?:\s|$)/.test(line)

const replaceStatusLine = (text: string, status: string): string => {
  const newline = text.lastIndexOf('\n')
  const finalLine = text.slice(newline + 1)
  if (isStatusLine(finalLine)) return `${text.slice(0, newline + 1)}${status}`
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
  element.text.startsWith('*状態*\n')

const hasTqStatusBlock = (block: SlackBlock): boolean =>
  block.type === 'context' && block.elements.some(isTqStatusElement)

const withUpdatedStatus = (
  content: SlackMessageContent,
  status: string,
): SlackMessageContent => {
  const originalBlocks = content.blocks ?? []
  const blocks = originalBlocks.some(hasTqStatusBlock)
    ? originalBlocks.map((block) => {
        if (block.type !== 'context') return block
        return {
          ...block,
          elements: block.elements.map((element) =>
            isTqStatusElement(element)
              ? { ...element, text: `*状態*\n${status}` }
              : element,
          ),
        }
      })
    : [
        ...originalBlocks,
        {
          type: 'context' as const,
          elements: [{ type: 'mrkdwn' as const, text: `*状態*\n${status}` }],
        },
      ]

  return {
    ...content,
    text: replaceStatusLine(content.text, status),
    blocks,
  }
}

const findAlertMessage = (notifier: SlackNotifier, taskId: string) => {
  const matchesTask = (payload: Record<string, unknown>): boolean =>
    payload['task_id'] === taskId

  return notifier
    .findMessageByMetadata('alert_task', matchesTask)
    .andThen((message) =>
      message === null
        ? notifier.findMessageByMetadata('grafana_alert', matchesTask)
        : okAsync(message),
    )
}

export const dispatchTqTaskStatusChanged = (
  notifier: SlackNotifier,
  tqWebUrl: string,
  payload: unknown,
): ResultAsync<DispatchOutcome, SlackApiError> => {
  const parsed = TaskStatusChangedWebhookEvent.safeParse(payload)
  if (!parsed.success) return okAsync<DispatchOutcome>('ignored')

  const { task } = parsed.data
  return findAlertMessage(notifier, task.id).andThen((message) => {
    if (message === null || message.content === undefined) {
      return okAsync<DispatchOutcome>('ignored')
    }

    const status = formatTqTaskStatus(
      {
        task: { id: task.id, number: task.number },
        status: task.status,
        statusReason: task.statusReason,
        ...(task.duplicateOfTask === undefined
          ? {}
          : { duplicateOfTask: task.duplicateOfTask }),
      },
      tqWebUrl,
    )

    return notifier
      .updateMessage(message.ref, withUpdatedStatus(message.content, status))
      .map((): DispatchOutcome => 'notified')
  })
}
