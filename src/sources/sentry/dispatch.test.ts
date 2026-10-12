import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { TqApiError, type TqClient } from '#plugins/tq/tq-client'
import type { DispatchContext } from '#sources/sentry/dispatch'
import { dispatch } from '#sources/sentry/dispatch'
import type { DispatchOutcome } from '#webhook-source'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const createNotifier = () => ({
  postMessage: vi.fn().mockReturnValue(okAsync({ channel: 'C1', ts: '1' })),
  updateMessage: vi.fn(),
  findMessageByMetadata: vi.fn(),
})

const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 42,
}

const createTqClient = (
  result: ReturnType<TqClient['createTask']> = okAsync(TQ_TASK_REF),
) => ({
  createTask: vi.fn().mockReturnValue(result),
})

const createContext = (
  notifier: DispatchContext['notifier'],
  tqClient = createTqClient(),
): DispatchContext => ({ deliveryId: 'req-1', notifier, tqClient })

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const observeDispatch = <TOutcome, TTaskCalls, TPostMessageCalls>(
  outcome: TOutcome,
  taskCalls: TTaskCalls,
  postMessageCalls: TPostMessageCalls,
) => ({ outcome, taskCalls, postMessageCalls })

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
    const tqClient = createTqClient()

    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      resource: 'event_alert',
      payload: issueAlertPayload(),
    })

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title:
              'Sentry alert: TypeError: Cannot read properties of undefined',
            description: [
              'Application: sample-app',
              'Issue: TypeError: Cannot read properties of undefined',
              'Level: error',
              'Location: src/example.ts in runTask',
              'Rule: Production errors',
              'Issue URL: https://sentry.io/organizations/example-org/issues/123/',
            ].join('\n'),
            context: 'personal',
          },
        ],
      ],
      postMessageCalls: [
        [
          {
            text: '🐛 TypeError: Cannot read properties of undefined\n未対応 · <https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42>',
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
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: '00000000-0000-4000-8000-000000000001',
              },
            },
          },
        ],
      ],
    })
  })

  it('posts the Sentry alert without a task link when tq task creation fails', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient(
      errAsync(new TqApiError('TQ API unavailable', undefined)),
    )

    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      resource: 'event_alert',
      payload: issueAlertPayload(),
    })

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title:
              'Sentry alert: TypeError: Cannot read properties of undefined',
            description: [
              'Application: sample-app',
              'Issue: TypeError: Cannot read properties of undefined',
              'Level: error',
              'Location: src/example.ts in runTask',
              'Rule: Production errors',
              'Issue URL: https://sentry.io/organizations/example-org/issues/123/',
            ].join('\n'),
            context: 'personal',
          },
        ],
      ],
      postMessageCalls: [
        [
          {
            text: '🐛 TypeError: Cannot read properties of undefined\n未対応',
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
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: '*状態*\n未対応' }],
              },
            ],
          },
        ],
      ],
    })
  })

  it('returns ignored without posting when the action is not triggered', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'event_alert',
      payload: issueAlertPayload({ action: 'resolved' }),
    })

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns ignored without posting when the resource is not event_alert', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'installation',
      payload: {},
    })

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns ignored without posting when action is missing from an unrelated event_alert payload shape', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'event_alert',
      payload: { foo: 'bar' },
    })

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })
})
