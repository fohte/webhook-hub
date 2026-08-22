import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildPayload,
  createSlackNotifier,
  SlackApiError,
  type SlackBlock,
  type SlackMessageContent,
} from '#slack'

const { conversationsList, chatPostMessage } = vi.hoisted(() => ({
  conversationsList: vi.fn(),
  chatPostMessage: vi.fn(),
}))

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function WebClient() {
    return {
      conversations: { list: conversationsList },
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

beforeEach(() => {
  conversationsList.mockReset()
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

describe('buildPayload', () => {
  it('returns a plain text payload when no color is set', () => {
    const content: SlackMessageContent = { text: 'hello' }
    expect(buildPayload(content)).toEqual({ text: 'hello' })
  })

  it('wraps text in a coloured attachment when color is set', () => {
    const content: SlackMessageContent = { text: 'hello', color: '#36a64f' }
    expect(buildPayload(content)).toEqual({
      attachments: [{ color: '#36a64f', text: 'hello', mrkdwn_in: ['text'] }],
      text: 'hello',
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
      attachments: [{ color: '#d73a49', blocks }],
      text: 'fallback',
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
