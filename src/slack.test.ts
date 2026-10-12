import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildPayload,
  createSlackNotifier,
  SlackApiError,
  type SlackBlock,
  type SlackMessageContent,
} from '#slack'

const { conversationsList, conversationsHistory, chatPostMessage } = vi.hoisted(
  () => ({
    conversationsList: vi.fn(),
    conversationsHistory: vi.fn(),
    chatPostMessage: vi.fn(),
  }),
)

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function WebClient() {
    return {
      conversations: {
        list: conversationsList,
        history: conversationsHistory,
      },
      chat: { postMessage: chatPostMessage },
    }
  }),
}))

const CHANNELS = [
  { id: 'CDEFAULT', name: 'default-channel' },
  { id: 'CACTIVITY', name: 'activity-channel' },
]

const LIST_CALL_ARGS = {
  types: 'public_channel,private_channel',
  exclude_archived: true,
  limit: 1000,
}

const observeHistory = <TResult, TCalls>(result: TResult, calls: TCalls) => ({
  result,
  calls,
})

beforeEach(() => {
  conversationsList.mockReset()
  conversationsHistory.mockReset()
  chatPostMessage.mockReset()
  conversationsList.mockResolvedValue({
    channels: CHANNELS,
    response_metadata: { next_cursor: '' },
  })
  chatPostMessage.mockResolvedValue({ ok: true, ts: '1', channel: 'C1' })
})

describe('postMessage', () => {
  it('resolves the notifier default channel when content.channel is omitted', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')

    await notifier.postMessage({ text: 'hi' })

    expect(chatPostMessage.mock.calls).toEqual([
      [{ channel: 'CDEFAULT', text: 'hi' }],
    ])
  })

  it('resolves content.channel instead of the notifier default channel when provided', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')

    await notifier.postMessage({ text: 'hi', channel: '#activity-channel' })

    expect(chatPostMessage.mock.calls).toEqual([
      [{ channel: 'CACTIVITY', text: 'hi' }],
    ])
  })

  it('resolves a channel only once across repeated calls', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')

    await notifier.postMessage({ text: 'hi' })
    await notifier.postMessage({ text: 'hi again' })

    expect(conversationsList.mock.calls).toEqual([[LIST_CALL_ARGS]])
  })

  it('caches the default channel and a message channel independently', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')

    await notifier.postMessage({ text: 'hi' })
    await notifier.postMessage({ text: 'hi', channel: '#activity-channel' })

    expect(chatPostMessage.mock.calls).toEqual([
      [{ channel: 'CDEFAULT', text: 'hi' }],
      [{ channel: 'CACTIVITY', text: 'hi' }],
    ])
    expect(conversationsList.mock.calls).toEqual([
      [LIST_CALL_ARGS],
      [LIST_CALL_ARGS],
    ])
  })

  it("keeps another channel's cache when one channel's resolution fails", async () => {
    const notifier = createSlackNotifier('token', '#default-channel')

    await notifier.postMessage({ text: 'hi', channel: '#activity-channel' })
    conversationsList.mockRejectedValueOnce(new Error('boom'))
    await notifier.postMessage({ text: 'hi' })
    await notifier.postMessage({ text: 'hi', channel: '#activity-channel' })

    // The failed #default-channel resolution must not be called again here,
    // and #activity-channel must still resolve from cache (no 3rd list call).
    expect(chatPostMessage.mock.calls).toEqual([
      [{ channel: 'CACTIVITY', text: 'hi' }],
      [{ channel: 'CACTIVITY', text: 'hi' }],
    ])
    expect(conversationsList.mock.calls).toEqual([
      [LIST_CALL_ARGS],
      [LIST_CALL_ARGS],
    ])
  })

  it('retries resolution for a channel whose previous resolution failed', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')
    const causeErr = new Error('boom')
    conversationsList.mockRejectedValueOnce(causeErr)

    const failed = await notifier.postMessage({ text: 'hi' })
    const retried = await notifier.postMessage({ text: 'hi' })

    expect(failed._unsafeUnwrapErr()).toEqual(
      new SlackApiError('failed to resolve Slack channel id', causeErr),
    )
    expect(retried._unsafeUnwrap()).toEqual({ ts: '1', channel: 'C1' })
    expect(conversationsList.mock.calls).toEqual([
      [LIST_CALL_ARGS],
      [LIST_CALL_ARGS],
    ])
  })
})

describe('findMessageByMetadata', () => {
  it('returns the matched message reference with its event payload', async () => {
    conversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: 'message-ts',
          metadata: {
            event_type: 'grafana_alert',
            event_payload: { fingerprint: 'fp-match', task_number: 9 },
          },
        },
      ],
    })
    const notifier = createSlackNotifier('token', '#default-channel')
    const result = await notifier
      .findMessageByMetadata(
        'grafana_alert',
        (payload) => payload['fingerprint'] === 'fp-match',
      )
      .match(
        (match) => match,
        () => null,
      )

    expect(observeHistory(result, conversationsHistory.mock.calls)).toEqual({
      result: {
        ref: { channel: 'CDEFAULT', ts: 'message-ts' },
        eventPayload: { fingerprint: 'fp-match', task_number: 9 },
      },
      calls: [
        [
          {
            channel: 'CDEFAULT',
            limit: 200,
            include_all_metadata: true,
          },
        ],
      ],
    })
  })

  it('continues through Slack history pages until it finds matching metadata', async () => {
    conversationsHistory
      .mockResolvedValueOnce({
        messages: [
          {
            ts: 'recent-ts',
            metadata: {
              event_type: 'other_alert',
              event_payload: { fingerprint: 'fp-other' },
            },
          },
        ],
        response_metadata: { next_cursor: 'page-two' },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            ts: 'older-ts',
            metadata: {
              event_type: 'grafana_alert',
              event_payload: { fingerprint: 'fp-match', task_number: 9 },
            },
          },
        ],
        response_metadata: { next_cursor: '' },
      })
    const notifier = createSlackNotifier('token', '#default-channel')
    const result = await notifier
      .findMessageByMetadata(
        'grafana_alert',
        (payload) => payload['fingerprint'] === 'fp-match',
      )
      .match(
        (match) => match,
        () => null,
      )

    expect(observeHistory(result, conversationsHistory.mock.calls)).toEqual({
      result: {
        ref: { channel: 'CDEFAULT', ts: 'older-ts' },
        eventPayload: { fingerprint: 'fp-match', task_number: 9 },
      },
      calls: [
        [
          {
            channel: 'CDEFAULT',
            limit: 200,
            include_all_metadata: true,
          },
        ],
        [
          {
            channel: 'CDEFAULT',
            limit: 200,
            include_all_metadata: true,
            cursor: 'page-two',
          },
        ],
      ],
    })
  })

  it('bounds history lookup to the requested time range and page count', async () => {
    conversationsHistory.mockResolvedValue({
      messages: [],
      response_metadata: { next_cursor: 'next-page' },
    })
    const notifier = createSlackNotifier('token', '#default-channel')
    const result = await notifier
      .findMessageByMetadata(
        'grafana_alert',
        (payload) => payload['fingerprint'] === 'fp-match',
        {
          oldest: '1767139200',
          latest: '1767312000',
          maxPages: 2,
        },
      )
      .match(
        (match) => match,
        () => null,
      )

    expect(observeHistory(result, conversationsHistory.mock.calls)).toEqual({
      result: null,
      calls: [
        [
          {
            channel: 'CDEFAULT',
            limit: 200,
            include_all_metadata: true,
            oldest: '1767139200',
            latest: '1767312000',
          },
        ],
        [
          {
            channel: 'CDEFAULT',
            limit: 200,
            include_all_metadata: true,
            oldest: '1767139200',
            latest: '1767312000',
            cursor: 'next-page',
          },
        ],
      ],
    })
  })
})

describe('buildPayload', () => {
  it('returns a plain text payload when no color is set', () => {
    const content: SlackMessageContent = { text: 'hello' }
    expect(buildPayload(content)).toEqual({ text: 'hello' })
  })

  it('wraps text in a coloured attachment when color is set', () => {
    const content: SlackMessageContent = { text: 'hello', color: '#36a64f' }
    expect(buildPayload(content)).toEqual({
      attachments: [
        {
          color: '#36a64f',
          text: 'hello',
          mrkdwn_in: ['text'],
          fallback: 'hello',
        },
      ],
    })
  })

  it('wraps blocks in a coloured attachment instead of text when blocks are set', () => {
    const blocks: SlackBlock[] = [
      { type: 'header', text: { type: 'plain_text', text: 'title' } },
    ]
    const content: SlackMessageContent = {
      text: 'fallback',
      color: '#d73a49',
      blocks,
    }
    expect(buildPayload(content)).toEqual({
      attachments: [{ color: '#d73a49', blocks, fallback: 'fallback' }],
    })
  })

  it('strips mrkdwn markup from the attachment fallback', () => {
    const content: SlackMessageContent = {
      text: '*bold* `code` <https://example.com|label>',
      color: '#36a64f',
    }
    expect(buildPayload(content)).toEqual({
      attachments: [
        {
          color: '#36a64f',
          text: '*bold* `code` <https://example.com|label>',
          mrkdwn_in: ['text'],
          fallback: 'bold code label',
        },
      ],
    })
  })

  it('includes metadata when set', () => {
    const content: SlackMessageContent = {
      text: 'hello',
      metadata: {
        event_type: 'security_pr',
        event_payload: { pr_url: 'https://example.com' },
      },
    }
    expect(buildPayload(content)).toEqual({
      text: 'hello',
      metadata: {
        event_type: 'security_pr',
        event_payload: { pr_url: 'https://example.com' },
      },
    })
  })
})
