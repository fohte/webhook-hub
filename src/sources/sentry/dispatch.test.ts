import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { dispatch } from '#sources/sentry/dispatch'
import type { DispatchOutcome } from '#webhook-source'

const createNotifier = () => ({
  postMessage: vi.fn().mockReturnValue(okAsync({ channel: 'C1', ts: '1' })),
  updateMessage: vi.fn(),
  findMessageByMetadata: vi.fn(),
})

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const observePostMessage = <TResult, TCalls>(
  result: TResult,
  postMessageCalls: TCalls,
) => ({ result, postMessageCalls })

const issueAlertPayload = (overrides: { action?: string } = {}): unknown => ({
  action: overrides.action ?? 'triggered',
  data: {
    event: {
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      web_url: 'https://sentry.io/organizations/example-org/issues/123/',
      url: 'https://sentry.io/api/0/projects/example-org/sample-app/events/456/',
      culprit: 'src/example.ts in runTask',
    },
    triggered_rule: 'Production errors',
  },
})

describe('dispatch', () => {
  it('posts to Slack and returns notified for a triggered event_alert', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      { deliveryId: 'req-1', notifier },
      { resource: 'event_alert', payload: issueAlertPayload() },
    )

    expect(
      observePostMessage(outcome, notifier.postMessage.mock.calls),
    ).toEqual({
      result: 'notified',
      postMessageCalls: [
        [
          {
            text: [
              '🐛 TypeError: Cannot read properties of undefined',
              'アプリ: sample-app',
              'Level: error',
              '発生箇所: `src/example.ts in runTask`',
              'Rule: Production errors',
              '<https://sentry.io/organizations/example-org/issues/123/|View issue>',
            ].join('\n'),
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: '🐛 TypeError: Cannot read properties of undefined',
                },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: '*アプリ*\nsample-app' },
                  { type: 'mrkdwn', text: '*Level*\nerror' },
                  {
                    type: 'mrkdwn',
                    text: '*発生箇所*\n`src/example.ts in runTask`',
                  },
                  { type: 'mrkdwn', text: '*Rule*\nProduction errors' },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '<https://sentry.io/organizations/example-org/issues/123/|View issue>',
                  },
                ],
              },
            ],
          },
        ],
      ],
    })
  })

  it('returns ignored without posting when the action is not triggered', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      { deliveryId: 'req-1', notifier },
      {
        resource: 'event_alert',
        payload: issueAlertPayload({ action: 'resolved' }),
      },
    )

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns ignored without posting when the resource is not event_alert', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      { deliveryId: 'req-1', notifier },
      { resource: 'installation', payload: {} },
    )

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns ignored without posting when action is missing from an unrelated event_alert payload shape', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      { deliveryId: 'req-1', notifier },
      { resource: 'event_alert', payload: { foo: 'bar' } },
    )

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })
})
