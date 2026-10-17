import { WebClient } from '@slack/web-api'
import { err, ok, type Result, ResultAsync } from 'neverthrow'

import type { SlackBlock, SlackMessageContent } from '#slack-message-content'
import {
  buildPayload,
  isRecord,
  readMessageContent,
  readMessageMetadata,
} from '#slack-message-content'

export type {
  SlackBlock,
  SlackMessageContent,
  SlackMessageMetadata,
} from '#slack-message-content'
export { buildPayload, isRecord, isSlackBlock } from '#slack-message-content'

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

interface SlackImageUpload {
  data: Buffer
  filename: string
  altText: string
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
  findMessagesByMetadata(
    eventType: string | readonly string[],
    payloadMatcher: (payload: Record<string, unknown>) => boolean,
    options?: SlackHistorySearchOptions,
  ): ResultAsync<SlackMessageMatch[], SlackApiError>
  uploadImage(image: SlackImageUpload): ResultAsync<string, SlackApiError>
}

export interface SlackScopeChecker {
  checkScopes(): ResultAsync<void, SlackApiError>
}

export type ManagedSlackNotifier = SlackNotifier & SlackScopeChecker

const wrapSlackApi = <T>(
  promise: Promise<T>,
  message: string,
): ResultAsync<T, SlackApiError> =>
  ResultAsync.fromPromise(
    promise,
    (caughtErr) => new SlackApiError(message, caughtErr),
  )

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

  const readMatchingMessages = (
    channelId: string,
    messages: readonly unknown[] | undefined,
    eventType: string | readonly string[],
    payloadMatcher: (payload: Record<string, unknown>) => boolean,
  ): SlackMessageMatch[] =>
    (messages ?? []).flatMap((message) => {
      const timestamp = isRecord(message) ? message['ts'] : undefined
      const metadata = readMessageMetadata(message)
      if (
        typeof timestamp !== 'string' ||
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
          ref: { channel: channelId, ts: timestamp },
          eventPayload: metadata.event_payload,
          ...(content === null ? {} : { content }),
        },
      ]
    })

  const searchMessagesInHistory = (
    channelId: string,
    eventType: string | readonly string[],
    payloadMatcher: (payload: Record<string, unknown>) => boolean,
    options: SlackHistorySearchOptions,
    stopAfterFirstMatch: boolean,
    cursor = '',
    page = 1,
    matches: SlackMessageMatch[] = [],
  ): ResultAsync<SlackMessageMatch[], SlackApiError> =>
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
      const pageMatches = readMatchingMessages(
        channelId,
        res.messages,
        eventType,
        payloadMatcher,
      )
      const allMatches = [...matches, ...pageMatches]
      const nextCursor = res.response_metadata?.next_cursor ?? ''
      return (stopAfterFirstMatch && allMatches.length > 0) ||
        nextCursor === '' ||
        page >= (options.maxPages ?? 5)
        ? ok(allMatches)
        : searchMessagesInHistory(
            channelId,
            eventType,
            payloadMatcher,
            options,
            stopAfterFirstMatch,
            nextCursor,
            page + 1,
            allMatches,
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
      const fileIds = collectSlackFileIds([
        ...(content.blocks ?? []),
        ...(content.additionalAttachments ?? []).flatMap(
          (attachment) => attachment.blocks ?? [],
        ),
      ])

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
        searchMessagesInHistory(
          channelId,
          eventType,
          payloadMatcher,
          options,
          true,
        ).map((matches) => matches[0] ?? null),
      )
    },
    findMessagesByMetadata(eventType, payloadMatcher, options = {}) {
      return resolveChannelId(defaultChannel).andThen((channelId) =>
        searchMessagesInHistory(
          channelId,
          eventType,
          payloadMatcher,
          options,
          false,
        ),
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
