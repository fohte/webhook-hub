import { WebClient } from '@slack/web-api'
import { err, ok, type Result, ResultAsync } from 'neverthrow'

export class SlackApiError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SlackApiError'
  }
}

export interface SlackMessageMetadata {
  event_type: string
  event_payload: Record<string, string | number | boolean>
}

export interface SlackMessageContent {
  text: string
  color?: string
  metadata?: SlackMessageMetadata
  /** Channel to post to. Falls back to the notifier's default channel when omitted. */
  channel?: string
}

export interface SlackMessageRef {
  channel: string
  ts: string
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
    eventType: string,
    payloadMatcher: (payload: Record<string, unknown>) => boolean,
  ): ResultAsync<SlackMessageRef | null, SlackApiError>
}

type MessagePayload = { metadata?: SlackMessageMetadata } & (
  | { text: string; attachments?: never }
  | {
      attachments: Array<{ color: string; text: string; mrkdwn_in: ['text'] }>
      text?: never
    }
)

const wrapSlackApi = <T>(
  promise: Promise<T>,
  message: string,
): ResultAsync<T, SlackApiError> =>
  ResultAsync.fromPromise(
    promise,
    (caughtErr) => new SlackApiError(message, caughtErr),
  )

const buildPayload = (content: SlackMessageContent): MessagePayload => {
  // Slack renders the coloured border only when the body lives inside the attachment.
  const base: MessagePayload =
    content.color !== undefined
      ? {
          attachments: [
            { color: content.color, text: content.text, mrkdwn_in: ['text'] },
          ],
        }
      : { text: content.text }
  return content.metadata !== undefined
    ? { ...base, metadata: content.metadata }
    : base
}

export const createSlackNotifier = (
  token: string,
  defaultChannel: string,
): SlackNotifier => {
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

  return {
    postMessage(content) {
      return resolveChannelId(content.channel ?? defaultChannel).andThen(
        (channelId) =>
          wrapSlackApi(
            client.chat.postMessage({
              channel: channelId,
              ...buildPayload(content),
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
      return wrapSlackApi(
        client.chat.update({
          channel: ref.channel,
          ts: ref.ts,
          ...buildPayload(content),
        }),
        'failed to update Slack message',
      ).map(() => undefined)
    },
    findMessageByMetadata(eventType, payloadMatcher) {
      return resolveChannelId(defaultChannel).andThen((channelId) =>
        wrapSlackApi(
          client.conversations.history({
            channel: channelId,
            limit: 200,
            include_all_metadata: true,
          }),
          'failed to fetch Slack conversation history',
        ).map((res) => {
          const match = res.messages?.find((m) => {
            const md = (m as { metadata?: Partial<SlackMessageMetadata> })
              .metadata
            if (md?.event_payload == null) return false
            if (md.event_type !== eventType) return false
            return payloadMatcher(md.event_payload)
          })
          if (match?.ts === undefined) return null
          return { channel: channelId, ts: match.ts }
        }),
      )
    },
  }
}
