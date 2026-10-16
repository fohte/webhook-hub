import type {
  ContextBlock,
  HeaderBlock,
  ImageBlock,
  SectionBlock,
} from '@slack/types'
import { WebClient } from '@slack/web-api'
import { err, ok, type Result, ResultAsync } from 'neverthrow'

import { toSlackFallbackText } from '#slack-mrkdwn'

export class SlackApiError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SlackApiError'
  }
}

export class SlackMissingScopesError extends SlackApiError {
  constructor(
    readonly missingScopes: string[],
    readonly grantedScopes: string[],
  ) {
    super(
      `Slack bot token is missing required scopes: ${missingScopes.join(', ')}`,
    )
    this.name = 'SlackMissingScopesError'
  }
}

export interface SlackMessageMetadata {
  event_type: string
  event_payload: Record<string, string | number | boolean>
}

export type SlackBlock = HeaderBlock | SectionBlock | ContextBlock | ImageBlock

interface SlackImageUpload {
  data: Buffer
  filename: string
  altText: string
}

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

export interface SlackMessageRef {
  channel: string
  ts: string
}

interface SlackMessageMatch {
  ref: SlackMessageRef
  eventPayload: Record<string, unknown>
  content?: SlackMessageContent
}

export interface SlackHistorySearchOptions {
  oldest?: string
  latest?: string
  maxPages?: number
}

export interface SlackNotifier {
  postMessage(
    content: SlackMessageContent,
  ): ResultAsync<SlackMessageRef, SlackApiError>
  updateMessage(
    ref: SlackMessageRef,
    content: SlackMessageContent,
  ): ResultAsync<void, SlackApiError>
  findMessageByMetadata(
    eventType: string | readonly string[],
    payloadMatcher: (payload: Record<string, unknown>) => boolean,
    options?: SlackHistorySearchOptions,
  ): ResultAsync<SlackMessageMatch | null, SlackApiError>
  uploadImage(image: SlackImageUpload): ResultAsync<string, SlackApiError>
}

export interface SlackScopeChecker {
  checkScopes(): ResultAsync<void, SlackApiError>
}

export type ManagedSlackNotifier = SlackNotifier & SlackScopeChecker

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

const wrapSlackApi = <T>(
  promise: Promise<T>,
  message: string,
): ResultAsync<T, SlackApiError> =>
  ResultAsync.fromPromise(
    promise,
    (caughtErr) => new SlackApiError(message, caughtErr),
  )

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

const collectSlackFileIds = (blocks: readonly SlackBlock[]): string[] =>
  blocks.flatMap((block) =>
    block.type === 'image' && 'slack_file' in block && 'id' in block.slack_file
      ? [block.slack_file.id]
      : [],
  )

export const createSlackNotifier = (
  token: string,
  defaultChannel: string,
): ManagedSlackNotifier => {
  const client = new WebClient(token)
  const channelIdCache = new Map<string, ResultAsync<string, SlackApiError>>()

  const resolveChannelIdUncached = (
    channel: string,
  ): ResultAsync<string, SlackApiError> =>
    wrapSlackApi(
      (async (): Promise<Result<string, SlackApiError>> => {
        if (!channel.startsWith('#')) return ok(channel)
        const name = channel.slice(1)
        let cursor = ''
        for (;;) {
          const res = await client.conversations.list({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 1000,
            ...(cursor === '' ? {} : { cursor }),
          })
          const found = res.channels?.find((c) => c.name === name)
          if (found?.id !== undefined) return ok(found.id)
          const next = res.response_metadata?.next_cursor ?? ''
          if (next === '') break
          cursor = next
        }
        return err(new SlackApiError(`Slack channel not found: ${channel}`))
      })(),
      'failed to resolve Slack channel id',
    ).andThen((result) => result)

  const resolveChannelId = (
    channel: string,
  ): ResultAsync<string, SlackApiError> => {
    const cached = channelIdCache.get(channel)
    if (cached !== undefined) return cached
    const resolved = resolveChannelIdUncached(channel).mapErr((caughtErr) => {
      channelIdCache.delete(channel)
      return caughtErr
    })
    channelIdCache.set(channel, resolved)
    return resolved
  }

  const findMessageInHistory = (
    channelId: string,
    eventType: string | readonly string[],
    payloadMatcher: (payload: Record<string, unknown>) => boolean,
    options: SlackHistorySearchOptions,
    cursor = '',
    page = 1,
  ): ResultAsync<SlackMessageMatch | null, SlackApiError> =>
    wrapSlackApi(
      client.conversations.history({
        channel: channelId,
        limit: 200,
        include_all_metadata: true,
        ...(options.oldest === undefined ? {} : { oldest: options.oldest }),
        ...(options.latest === undefined ? {} : { latest: options.latest }),
        ...(cursor === '' ? {} : { cursor }),
      }),
      'failed to fetch Slack conversation history',
    ).andThen((res) => {
      const match = res.messages?.flatMap((message) => {
        const metadata = readMessageMetadata(message)
        if (
          message.ts === undefined ||
          metadata === null ||
          (typeof eventType === 'string'
            ? metadata.event_type !== eventType
            : !eventType.includes(metadata.event_type)) ||
          !payloadMatcher(metadata.event_payload)
        ) {
          return []
        }
        const content = readMessageContent(message)
        return [
          {
            ref: { channel: channelId, ts: message.ts },
            eventPayload: metadata.event_payload,
            ...(content === null ? {} : { content }),
          },
        ]
      })[0]
      if (match !== undefined) return ok(match)

      const nextCursor = res.response_metadata?.next_cursor ?? ''
      return nextCursor === '' || page >= (options.maxPages ?? 5)
        ? ok(null)
        : findMessageInHistory(
            channelId,
            eventType,
            payloadMatcher,
            options,
            nextCursor,
            page + 1,
          )
    })

  return {
    postMessage(content) {
      return resolveChannelId(content.channel ?? defaultChannel).andThen(
        (channelId) =>
          wrapSlackApi(
            client.chat.postMessage({
              channel: channelId,
              ...buildPayload(content),
              ...(content.username !== undefined
                ? { username: content.username }
                : {}),
              ...(content.iconUrl !== undefined
                ? { icon_url: content.iconUrl }
                : {}),
            }),
            'failed to post Slack message',
          ).andThen((res) =>
            res.ts === undefined || res.channel === undefined
              ? err(
                  new SlackApiError(
                    'Slack postMessage did not return ts/channel',
                  ),
                )
              : ok({ ts: res.ts, channel: res.channel }),
          ),
      )
    },
    updateMessage(ref, content) {
      const fileIds = collectSlackFileIds(content.blocks ?? [])

      return wrapSlackApi(
        client.chat.update({
          channel: ref.channel,
          ts: ref.ts,
          ...buildPayload(content),
          ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
        }),
        'failed to update Slack message',
      ).map(() => undefined)
    },
    findMessageByMetadata(eventType, payloadMatcher, options = {}) {
      return resolveChannelId(defaultChannel).andThen((channelId) =>
        findMessageInHistory(channelId, eventType, payloadMatcher, options),
      )
    },
    uploadImage(image) {
      // Slack posts a file as a separate message when `channel_id` is provided.
      return wrapSlackApi(
        client.filesUploadV2({
          file: image.data,
          filename: image.filename,
          title: image.filename,
          alt_text: image.altText,
        }),
        'failed to upload Slack image',
      ).andThen((res) => {
        const fileId = res.files[0]?.files?.[0]?.id
        return fileId === undefined
          ? err(new SlackApiError('Slack upload did not return a file ID'))
          : ok(fileId)
      })
    },
    checkScopes() {
      return wrapSlackApi(
        client.auth.test(),
        'failed to check Slack scopes',
      ).andThen((res) => {
        const grantedScopes = res.response_metadata?.scopes
        if (grantedScopes === undefined) {
          return err(new SlackMissingScopesError(['x-oauth-scopes'], []))
        }

        const granted = new Set(grantedScopes)
        const missingScopes = [
          'chat:write',
          'chat:write.customize',
          'metadata.message:read',
          'files:write',
        ].filter((scope) => !granted.has(scope))
        const hasPublicChannelScopes =
          granted.has('channels:history') && granted.has('channels:read')
        const hasPrivateChannelScopes =
          granted.has('groups:history') && granted.has('groups:read')
        if (!hasPublicChannelScopes && !hasPrivateChannelScopes) {
          missingScopes.push(
            'channels:history + channels:read or groups:history + groups:read',
          )
        }

        return missingScopes.length === 0
          ? ok(undefined)
          : err(new SlackMissingScopesError(missingScopes, grantedScopes))
      })
    },
  }
}
