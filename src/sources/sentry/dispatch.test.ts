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
  postMessage: vi
    .fn()
    .mockReturnValue(okAsync({ channel: 'C-FAKE', ts: '1720000000.000001' })),
  updateMessage: vi.fn(),
  findMessageByMetadata: vi.fn(),
  uploadImage: vi.fn().mockReturnValue(okAsync('FIMAGE')),
})

const TQ_TASK_REF = {
  id: '11111111-1111-4111-8111-111111111111',
  number: 7319,
}
const TQ_WEB_URL = 'https://tq.example.test'
const ISSUE_TITLE = 'WidgetReadFault: catalog request failed'
const ISSUE_URL = 'https://monitoring.example.test/issues/456'

const createTqClient = (
  result: ReturnType<TqClient['createTask']> = okAsync(TQ_TASK_REF),
) => ({
  createTask: vi.fn().mockReturnValue(result),
})

const createContext = (
  notifier: DispatchContext['notifier'],
  tqClient = createTqClient(),
  tqWebUrl = TQ_WEB_URL,
): DispatchContext => ({
  deliveryId: 'delivery-example',
  notifier,
  tqClient,
  tqWebUrl,
})

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const observeDispatch = <TOutcome, TTaskCalls, TPostMessageCalls>(
  outcome: TOutcome,
  taskCalls: TTaskCalls,
  postMessageCalls: TPostMessageCalls,
) => ({ outcome, taskCalls, postMessageCalls })

const issueAlertPayload = (): unknown => ({
  action: 'triggered',
  data: {
    event: {
      title: ISSUE_TITLE,
      level: 'error',
      web_url: ISSUE_URL,
      url: 'https://monitoring.example.test/api/0/projects/demo-team/widget-service/events/abc',
      culprit: 'src/widgets/read.ts in readWidget',
    },
    triggered_rule: 'widget failures',
  },
})

const expectedTaskRequest = {
  title: `Sentry alert: ${ISSUE_TITLE}`,
  description: [
    'Application: widget-service',
    `Issue: ${ISSUE_TITLE}`,
    'Level: error',
    'Location: src/widgets/read.ts in readWidget',
    'Rule: widget failures',
    `Issue URL: ${ISSUE_URL}`,
  ].join('\n'),
  context: 'personal',
}

const expectedSourceContent = {
  text: ISSUE_TITLE,
  color: '#d73a49',
  username: 'Sentry',
  iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: ISSUE_TITLE },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '`widget-service`' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://monitoring.example.test/issues/456|View issue>',
        },
      ],
    },
  ],
}

const expectedTqAttachment = {
  text: '<https://tq.example.test/tasks/11111111-1111-4111-8111-111111111111|tq #7319> · todo',
  color: '#2eb67d',
  blocks: [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://tq.example.test/tasks/11111111-1111-4111-8111-111111111111|tq #7319> · todo',
        },
      ],
    },
  ],
}

describe('dispatch', () => {
  it('posts a triggered event_alert and returns notified', async () => {
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
      taskCalls: [[expectedTaskRequest]],
      postMessageCalls: [
        [
          {
            ...expectedSourceContent,
            additionalAttachments: [expectedTqAttachment],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: '11111111-1111-4111-8111-111111111111',
                tq_task_status: 'todo',
                tq_task_status_reason: 'none',
              },
            },
          },
        ],
      ],
    })
  })

  it('posts a triggered event_alert when its event details are missing', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()

    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      resource: 'event_alert',
      payload: { action: 'triggered' },
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
            title: 'Sentry alert: Sentry issue alert',
            description: 'Issue: Sentry issue alert',
            context: 'personal',
          },
        ],
      ],
      postMessageCalls: [
        [
          {
            text: 'Sentry issue alert',
            color: '#d73a49',
            username: 'Sentry',
            iconUrl: 'https://avatars.githubusercontent.com/u/1396951?v=4',
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: 'Sentry issue alert',
                },
              },
            ],
            additionalAttachments: [expectedTqAttachment],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: '11111111-1111-4111-8111-111111111111',
                tq_task_status: 'todo',
                tq_task_status_reason: 'none',
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
      taskCalls: [[expectedTaskRequest]],
      postMessageCalls: [[expectedSourceContent]],
    })
  })

  it('returns ignored without posting when the action is not triggered', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()

    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      resource: 'event_alert',
      payload: { action: 'resolved' },
    })

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
      ),
    ).toEqual({ outcome: 'ignored', taskCalls: [], postMessageCalls: [] })
  })

  it('returns ignored without posting when the resource is not event_alert', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()

    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      resource: 'installation',
      payload: {},
    })

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
      ),
    ).toEqual({ outcome: 'ignored', taskCalls: [], postMessageCalls: [] })
  })

  it('returns ignored when action is missing from an event_alert payload', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()

    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      resource: 'event_alert',
      payload: { foo: 'bar' },
    })

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
      ),
    ).toEqual({ outcome: 'ignored', taskCalls: [], postMessageCalls: [] })
  })
})
