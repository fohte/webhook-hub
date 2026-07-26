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

const issueAlertPayload = (overrides: { action?: string } = {}): unknown => ({
  action: overrides.action ?? 'triggered',
  data: {
    event: {
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      web_url: 'https://sentry.io/organizations/fohte/issues/1/',
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

    expect(outcome).toBe('notified')
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: [
        ':rotating_light: *Sentry alert: TypeError: Cannot read properties of undefined*',
        'Level: *error* / Rule: *Production errors*',
        '<https://sentry.io/organizations/fohte/issues/1/|View issue>',
      ].join('\n'),
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
