import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildPayload,
  createSlackNotifier,
  SlackApiError,
  type SlackBlock,
  type SlackMessageContent,
  SlackMissingScopesError,
} from '#slack'

const {
  conversationsList,
  conversationsHistory,
  chatPostMessage,
  filesUploadV2,
  authTest,
} = vi.hoisted(() => ({
  conversationsList: vi.fn(),
  conversationsHistory: vi.fn(),
  chatPostMessage: vi.fn(),
  filesUploadV2: vi.fn(),
  authTest: vi.fn(),
}))

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function WebClient() {
    return {
      conversations: {
        list: conversationsList,
        history: conversationsHistory,
      },
      chat: { postMessage: chatPostMessage },
      filesUploadV2,
      auth: { test: authTest },
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

const observe = <TResult, TCalls>(result: TResult, calls: TCalls) => ({
  result,
  calls,
})

beforeEach(() => {
  conversationsList.mockReset()
  conversationsHistory.mockReset()
  chatPostMessage.mockReset()
  filesUploadV2.mockReset()
  authTest.mockReset()
  conversationsList.mockResolvedValue({
    channels: CHANNELS,
    response_metadata: { next_cursor: '' },
  })
  chatPostMessage.mockResolvedValue({ ok: true, ts: '1', channel: 'C1' })
  filesUploadV2.mockResolvedValue({
    ok: true,
    files: [{ ok: true, files: [{ id: 'FIMAGE' }] }],
  })
  authTest.mockResolvedValue({
    ok: true,
    response_metadata: {
      scopes: [
        'chat:write',
        'chat:write.customize',
        'metadata.message:read',
        'files:write',
        'channels:history',
        'channels:read',
      ],
    },
  })
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
            event_payload: {
              fingerprint: 'fp-match',
              task_number: 9,
              task_id: 'task-example-id',
              tq_task_status: 'completed',
              tq_task_status_reason: 'completed',
            },
          },
          attachments: [
            {
              color: '#d73a49',
              fallback: 'Alert details\n対応済み · tq #9',
              blocks: [
                {
                  type: 'header',
                  text: { type: 'plain_text', text: 'Alert details' },
                },
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: '*Summary*\nExample details' },
                },
                {
                  type: 'image',
                  slack_file: { id: 'FEXAMPLE' },
                  alt_text: 'Example panel',
                },
                {
                  type: 'context',
                  elements: [
                    {
                      type: 'mrkdwn',
                      text: '*状態*\n対応済み · <https://tasks.example.test/tasks/task-example-id|tq #9>',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const notifier = createSlackNotifier('token', '#default-channel')
    const result = await notifier
      .findMessageByMetadata(
        ['alert_task', 'grafana_alert'],
        (payload) => payload['task_id'] === 'task-example-id',
      )
      .match(
        (match) => match,
        () => null,
      )

    expect(observe(result, conversationsHistory.mock.calls)).toEqual({
      result: {
        ref: { channel: 'CDEFAULT', ts: 'message-ts' },
        eventPayload: {
          fingerprint: 'fp-match',
          task_number: 9,
          task_id: 'task-example-id',
          tq_task_status: 'completed',
          tq_task_status_reason: 'completed',
        },
        content: {
          text: 'Alert details\n対応済み · tq #9',
          color: '#d73a49',
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: 'Alert details' },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '*Summary*\nExample details' },
            },
            {
              type: 'image',
              slack_file: { id: 'FEXAMPLE' },
              alt_text: 'Example panel',
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '*状態*\n対応済み · <https://tasks.example.test/tasks/task-example-id|tq #9>',
                },
              ],
            },
          ],
          metadata: {
            event_type: 'grafana_alert',
            event_payload: {
              fingerprint: 'fp-match',
              task_number: 9,
              task_id: 'task-example-id',
              tq_task_status: 'completed',
              tq_task_status_reason: 'completed',
            },
          },
        },
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

    expect(observe(result, conversationsHistory.mock.calls)).toEqual({
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

    expect(observe(result, conversationsHistory.mock.calls)).toEqual({
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

  it('keeps blocks on an uncoloured message', () => {
    const blocks: SlackBlock[] = [
      { type: 'header', text: { type: 'plain_text', text: 'title' } },
    ]
    const content: SlackMessageContent = { text: 'fallback', blocks }

    expect(buildPayload(content)).toEqual({ text: 'fallback', blocks })
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

describe('uploadImage', () => {
  it('uploads a private PNG for use in a Slack image block', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')
    const image = Buffer.from('png-data')
    const fileId = await notifier
      .uploadImage({
        data: image,
        filename: 'grafana-panel-17.png',
        altText: 'Grafana panel 17',
      })
      .match(
        (value) => value,
        () => null,
      )

    expect(observe(fileId, filesUploadV2.mock.calls)).toEqual({
      result: 'FIMAGE',
      calls: [
        [
          {
            file: image,
            filename: 'grafana-panel-17.png',
            title: 'grafana-panel-17.png',
            alt_text: 'Grafana panel 17',
          },
        ],
      ],
    })
  })
})

describe('checkScopes', () => {
  it('accepts the required public-channel scopes from auth.test response metadata', async () => {
    const notifier = createSlackNotifier('token', '#default-channel')
    const result = await notifier.checkScopes().match(
      () => 'ok',
      (error) => error.message,
    )

    expect(observe(result, authTest.mock.calls)).toEqual({
      result: 'ok',
      calls: [[]],
    })
  })

  it('reports the missing files:write scope without rejecting other valid scopes', async () => {
    authTest.mockResolvedValueOnce({
      ok: true,
      response_metadata: {
        scopes: [
          'chat:write',
          'chat:write.customize',
          'metadata.message:read',
          'groups:history',
          'groups:read',
        ],
      },
    })
    const notifier = createSlackNotifier('token', '#default-channel')
    const result = await notifier.checkScopes().match(
      () => ({ kind: 'ok' }),
      (error) => ({
        kind: 'error',
        name: error.name,
        message: error.message,
        missingScopes:
          error instanceof SlackMissingScopesError ? error.missingScopes : [],
      }),
    )

    expect(observe(result, authTest.mock.calls)).toEqual({
      result: {
        kind: 'error',
        name: 'SlackMissingScopesError',
        message: 'Slack bot token is missing required scopes: files:write',
        missingScopes: ['files:write'],
      },
      calls: [[]],
    })
  })
})
