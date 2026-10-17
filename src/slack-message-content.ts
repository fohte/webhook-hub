import type {
  ContextBlock,
  HeaderBlock,
  ImageBlock,
  SectionBlock,
} from '@slack/types'

import { toSlackFallbackText } from '#slack-mrkdwn'

export interface SlackMessageMetadata {
  event_type: string
  event_payload: Record<string, string | number | boolean>
}

export type SlackBlock = HeaderBlock | SectionBlock | ContextBlock | ImageBlock

export interface SlackMessageContent {
  text: string
  color?: string
  metadata?: SlackMessageMetadata
  /** Channel to post to. Falls back to the notifier's default channel when omitted. */
  channel?: string
  blocks?: SlackBlock[]
  /** Only honoured by postMessage — chat.update cannot change a message's authorship. */
  username?: string
  /** Only honoured by postMessage — chat.update cannot change a message's authorship. */
  iconUrl?: string
}

type SlackAttachment =
  | { color: string; text: string; mrkdwn_in: ['text']; fallback: string }
  | { color: string; blocks: SlackBlock[]; fallback: string }

type MessagePayload = { metadata?: SlackMessageMetadata } & (
  | { text: string; attachments?: never; blocks?: SlackBlock[] }
  | { attachments: SlackAttachment[]; text?: never }
)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTextObject = (value: unknown): boolean =>
  isRecord(value) &&
  (value['type'] === 'mrkdwn' || value['type'] === 'plain_text') &&
  typeof value['text'] === 'string'

export const isSlackBlock = (value: unknown): value is SlackBlock => {
  if (!isRecord(value)) return false
  switch (value['type']) {
    case 'header':
      return (
        isRecord(value['text']) &&
        value['text']['type'] === 'plain_text' &&
        typeof value['text']['text'] === 'string'
      )
    case 'section':
      return (
        (value['text'] === undefined || isTextObject(value['text'])) &&
        (value['fields'] === undefined ||
          (Array.isArray(value['fields']) &&
            value['fields'].every(isTextObject)))
      )
    case 'context':
      return (
        Array.isArray(value['elements']) &&
        value['elements'].every(isTextObject)
      )
    case 'image':
      return (
        typeof value['alt_text'] === 'string' &&
        isRecord(value['slack_file']) &&
        typeof value['slack_file']['id'] === 'string'
      )
    default:
      return false
  }
}

const readMessageMetadata = (message: unknown): SlackMessageMetadata | null => {
  if (!isRecord(message)) return null
  const metadata = message['metadata']
  if (!isRecord(metadata)) return null
  const eventType = metadata['event_type']
  const eventPayload = metadata['event_payload']
  if (typeof eventType !== 'string' || !isRecord(eventPayload)) return null
  const normalizedPayload: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(eventPayload)) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return null
    }
    normalizedPayload[key] = value
  }
  return { event_type: eventType, event_payload: normalizedPayload }
}

const readMessageContent = (message: unknown): SlackMessageContent | null => {
  if (!isRecord(message)) return null
  const attachment = Array.isArray(message['attachments'])
    ? message['attachments'].find(isRecord)
    : undefined
  const rawBlocks = attachment?.['blocks'] ?? message['blocks']
  if (rawBlocks !== undefined && !Array.isArray(rawBlocks)) return null
  const blocks = Array.isArray(rawBlocks)
    ? rawBlocks.every(isSlackBlock)
      ? rawBlocks
      : null
    : undefined
  if (blocks === null) return null

  const text =
    (typeof attachment?.['fallback'] === 'string'
      ? attachment['fallback']
      : undefined) ??
    (typeof attachment?.['text'] === 'string'
      ? attachment['text']
      : undefined) ??
    (typeof message['text'] === 'string' ? message['text'] : undefined)
  if (text === undefined) return null

  const color = attachment?.['color']
  const metadata = readMessageMetadata(message)
  return {
    text,
    ...(typeof color === 'string' ? { color } : {}),
    ...(blocks === undefined ? {} : { blocks }),
    ...(metadata === null ? {} : { metadata }),
  }
}

export const buildPayload = (content: SlackMessageContent): MessagePayload => {
  // Slack renders the coloured border only when the body lives inside the attachment.
  // Top-level `text` must stay unset here: when the body lives in an attachment,
  // Slack still renders top-level `text` as a second, separate message body above
  // it, duplicating the content. `fallback` is the attachment-scoped equivalent
  // for clients that can't render attachments/blocks (push notifications, IRC).
  const base: MessagePayload =
    content.color !== undefined
      ? {
          attachments: [
            content.blocks !== undefined
              ? {
                  color: content.color,
                  blocks: content.blocks,
                  fallback: toSlackFallbackText(content.text),
                }
              : {
                  color: content.color,
                  text: content.text,
                  mrkdwn_in: ['text'],
                  fallback: toSlackFallbackText(content.text),
                },
          ],
        }
      : { text: content.text }
  const withBlocks =
    content.color === undefined && content.blocks !== undefined
      ? { ...base, blocks: content.blocks }
      : base
  return content.metadata !== undefined
    ? { ...withBlocks, metadata: content.metadata }
    : withBlocks
}

export { readMessageContent, readMessageMetadata }
