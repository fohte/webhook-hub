import { describe, expect, it } from 'vitest'

import { buildPayload, type SlackBlock, type SlackMessageContent } from '#slack'

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
