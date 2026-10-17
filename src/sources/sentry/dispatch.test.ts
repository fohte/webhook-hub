import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { setSourceAlertResolved } from '#plugins/tq/alert-source-appearance'
import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task'
import { TqApiError, type TqClient } from '#plugins/tq/tq-client'
import { SlackApiError, type SlackMessageContent } from '#slack'
import type { DispatchContext } from '#sources/sentry/dispatch'
import { dispatch } from '#sources/sentry/dispatch'
import type { DispatchOutcome } from '#webhook-source'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const createNotifier = () => ({
  postMessage: vi
    .fn<DispatchContext['notifier']['postMessage']>()
    .mockReturnValue(okAsync({ channel: 'C-FAKE', ts: '1720000000.000001' })),
  updateMessage: vi
    .fn<DispatchContext['notifier']['updateMessage']>()
    .mockReturnValue(okAsync(undefined)),
  findMessageByMetadata: vi
    .fn<DispatchContext['notifier']['findMessageByMetadata']>()
    .mockReturnValue(okAsync(null)),
  findMessagesByMetadata: vi
    .fn<DispatchContext['notifier']['findMessagesByMetadata']>()
    .mockReturnValue(okAsync([])),
  uploadImage: vi.fn().mockReturnValue(okAsync('FIMAGE')),
})

const TQ_TASK_REF = {
  id: '11111111-1111-4111-8111-111111111111',
  number: 7319,
}
const TQ_WEB_URL = 'https://tq.example.test'
const ISSUE_TITLE = 'WidgetReadFault: catalog request failed'
const ISSUE_URL = 'https://monitoring.example.test/issues/456'
const SENTRY_ISSUE_ID = 'sentry-issue-42'
const SENTRY_MESSAGE_REF = { channel: 'C-TEST', ts: '1700000000.000001' }

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

const observeIssueStateDispatch = <TOutcome, TSearch, TUpdateCalls>(
  outcome: TOutcome,
  search: TSearch,
  updateCalls: TUpdateCalls,
) => ({ outcome, search, updateCalls })

const issueAlertPayload = (
  overrides: {
    action?: string
    issueIdField?: 'issue_id' | 'group_id'
  } = {},
): unknown => ({
  action: overrides.action ?? 'triggered',
  data: {
    event: {
      [overrides.issueIdField ?? 'issue_id']: SENTRY_ISSUE_ID,
      title: ISSUE_TITLE,
      level: 'error',
      web_url: ISSUE_URL,
      url: 'https://monitoring.example.test/api/0/projects/demo-team/widget-service/events/abc',
      culprit: 'src/widgets/read.ts in readWidget',
    },
    triggered_rule: 'widget failures',
  },
})

const existingSentryContent = (): SlackMessageContent => ({
  text: 'Sentry issue title',
  color: '#d73a49',
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Sentry issue title' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://sentry.example.invalid/issues/sentry-issue-42|View issue>',
        },
      ],
    },
  ],
  additionalAttachments: [
    {
      text: '<https://tq.example.invalid/tasks/task-42|tq task-42> · todo',
      color: '#2eb67d',
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '<https://tq.example.invalid/tasks/task-42|tq task-42> · todo',
            },
          ],
        },
      ],
    },
  ],
  metadata: {
    event_type: 'alert_task',
    event_payload: {
      task_id: 'task-42',
      sentry_issue_id: SENTRY_ISSUE_ID,
      tq_task_status: 'todo',
      tq_task_status_reason: 'none',
    },
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
  metadata: {
    event_type: 'alert_task',
    event_payload: { sentry_issue_id: SENTRY_ISSUE_ID },
  },
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
                sentry_issue_id: SENTRY_ISSUE_ID,
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

  it('falls back to the Sentry event group_id for the issue metadata', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'event_alert',
      payload: issueAlertPayload({ issueIdField: 'group_id' }),
    })
    expect(
      observeIssueStateDispatch(
        outcome,
        notifier.postMessage.mock.calls.map(
          ([content]) => content.metadata ?? null,
        ),
        [],
      ),
    ).toEqual({
      outcome: 'notified',
      search: [
        {
          event_type: 'alert_task',
          event_payload: {
            task_id: '11111111-1111-4111-8111-111111111111',
            sentry_issue_id: SENTRY_ISSUE_ID,
            tq_task_status: 'todo',
            tq_task_status_reason: 'none',
          },
        },
      ],
      updateCalls: [],
    })
  })

  it('folds the matching Sentry notification when an issue is resolved', async () => {
    const notifier = createNotifier()
    const content = existingSentryContent()
    const olderContent = existingSentryContent()
    const olderMessageRef = { channel: 'C-TEST', ts: '1699999999.000001' }
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: SENTRY_MESSAGE_REF,
          eventPayload: content.metadata?.event_payload ?? {},
          content,
        },
        {
          ref: olderMessageRef,
          eventPayload: olderContent.metadata?.event_payload ?? {},
          content: olderContent,
        },
      ]),
    )

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'resolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })
    const searchCall = notifier.findMessagesByMetadata.mock.calls[0]
    const payloadMatcher = searchCall?.[1]

    expect(
      observeIssueStateDispatch(
        outcome,
        {
          eventType: searchCall?.[0],
          matchesTarget:
            typeof payloadMatcher === 'function'
              ? payloadMatcher({ sentry_issue_id: SENTRY_ISSUE_ID })
              : null,
          matchesOther:
            typeof payloadMatcher === 'function'
              ? payloadMatcher({ sentry_issue_id: 'another-issue' })
              : null,
          options: searchCall?.[2] ?? {},
        },
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      search: {
        eventType: 'alert_task',
        matchesTarget: true,
        matchesOther: false,
        options: {},
      },
      updateCalls: [
        [SENTRY_MESSAGE_REF, setSourceAlertResolved(content, true)],
        [olderMessageRef, setSourceAlertResolved(olderContent, true)],
      ],
    })
  })

  it('restores the matching Sentry notification when an issue is unresolved', async () => {
    const notifier = createNotifier()
    const original = existingSentryContent()
    const resolved = setSourceAlertResolved(original, true)
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: SENTRY_MESSAGE_REF,
          eventPayload: resolved.metadata?.event_payload ?? {},
          content: resolved,
        },
      ]),
    )

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'unresolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })

    expect(
      observeIssueStateDispatch(
        outcome,
        null,
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      search: null,
      updateCalls: [
        [SENTRY_MESSAGE_REF, setSourceAlertResolved(resolved, false)],
      ],
    })
  })

  it('matches an issue state webhook by its event group_id', async () => {
    const notifier = createNotifier()
    const content = existingSentryContent()
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: SENTRY_MESSAGE_REF,
          eventPayload: content.metadata?.event_payload ?? {},
          content,
        },
      ]),
    )

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'resolved',
        data: { event: { group_id: SENTRY_ISSUE_ID } },
      },
    })
    const searchCall = notifier.findMessagesByMetadata.mock.calls[0]
    const payloadMatcher = searchCall?.[1]

    expect(
      observeIssueStateDispatch(
        outcome,
        {
          eventType: searchCall?.[0],
          matchesTarget:
            typeof payloadMatcher === 'function'
              ? payloadMatcher({ sentry_issue_id: SENTRY_ISSUE_ID })
              : null,
          options: searchCall?.[2] ?? {},
        },
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      search: {
        eventType: 'alert_task',
        matchesTarget: true,
        options: {},
      },
      updateCalls: [
        [SENTRY_MESSAGE_REF, setSourceAlertResolved(content, true)],
      ],
    })
  })

  it('attempts every matching notification and aggregates update failures', async () => {
    const notifier = createNotifier()
    const firstContent = existingSentryContent()
    const secondContent = existingSentryContent()
    const thirdContent = existingSentryContent()
    const firstRef = { channel: 'C-TEST', ts: '1700000000.000001' }
    const secondRef = { channel: 'C-TEST', ts: '1700000000.000002' }
    const thirdRef = { channel: 'C-TEST', ts: '1700000000.000003' }
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: firstRef,
          eventPayload: firstContent.metadata?.event_payload ?? {},
          content: firstContent,
        },
        {
          ref: secondRef,
          eventPayload: secondContent.metadata?.event_payload ?? {},
          content: secondContent,
        },
        {
          ref: thirdRef,
          eventPayload: thirdContent.metadata?.event_payload ?? {},
          content: thirdContent,
        },
      ]),
    )
    notifier.updateMessage
      .mockReturnValueOnce(errAsync(new SlackApiError('first update failed')))
      .mockReturnValueOnce(okAsync(undefined))
      .mockReturnValueOnce(errAsync(new SlackApiError('third update failed')))

    const result = await dispatch(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'resolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })
    const summary = result.match(
      (outcome) => ({ outcome, error: null }),
      (error) => ({
        outcome: null,
        error: {
          message: error.message,
          failures:
            error.cause instanceof AggregateError
              ? error.cause.errors.map((cause) =>
                  cause instanceof Error ? cause.message : String(cause),
                )
              : [],
        },
      }),
    )

    expect(
      observeIssueStateDispatch(
        summary,
        null,
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({
      outcome: {
        outcome: null,
        error: {
          message: 'failed to update 2 Sentry issue notifications',
          failures: ['first update failed', 'third update failed'],
        },
      },
      search: null,
      updateCalls: [
        [firstRef, setSourceAlertResolved(firstContent, true)],
        [secondRef, setSourceAlertResolved(secondContent, true)],
        [thirdRef, setSourceAlertResolved(thirdContent, true)],
      ],
    })
  })

  it('skips an issue notification that is already folded', async () => {
    const notifier = createNotifier()
    const sourceContent = existingSentryContent()
    const foldedContent = setSourceAlertResolved(sourceContent, true)
    const historyContent = {
      ...foldedContent,
      text: 'Slack fallback text for folded content',
    }
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: SENTRY_MESSAGE_REF,
          eventPayload: foldedContent.metadata?.event_payload ?? {},
          content: historyContent,
        },
      ]),
    )

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'resolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })

    expect(
      observeIssueStateDispatch(
        outcome,
        null,
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({ outcome: 'ignored', search: null, updateCalls: [] })
  })

  it('skips an issue notification that is already restored', async () => {
    const notifier = createNotifier()
    const originalContent = existingSentryContent()
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: SENTRY_MESSAGE_REF,
          eventPayload: originalContent.metadata?.event_payload ?? {},
          content: originalContent,
        },
      ]),
    )

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'unresolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })

    expect(
      observeIssueStateDispatch(
        outcome,
        null,
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({ outcome: 'ignored', search: null, updateCalls: [] })
  })

  it('does nothing when no Sentry notification matches the issue', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'resolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })
    const searchCall = notifier.findMessagesByMetadata.mock.calls[0]
    const payloadMatcher = searchCall?.[1]

    expect(
      observeIssueStateDispatch(
        outcome,
        {
          eventType: searchCall?.[0],
          matchesTarget:
            typeof payloadMatcher === 'function'
              ? payloadMatcher({ sentry_issue_id: SENTRY_ISSUE_ID })
              : null,
          options: searchCall?.[2] ?? {},
        },
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'ignored',
      search: {
        eventType: 'alert_task',
        matchesTarget: true,
        options: {},
      },
      updateCalls: [],
    })
  })

  it('skips unreadable matching messages and updates the remaining matches', async () => {
    const notifier = createNotifier()
    const content = existingSentryContent()
    const unreadableRef = { channel: 'C-TEST', ts: '1700000000.000000' }
    const readableRef = { channel: 'C-TEST', ts: '1700000000.000001' }
    notifier.findMessagesByMetadata.mockReturnValue(
      okAsync([
        {
          ref: unreadableRef,
          eventPayload: {
            sentry_issue_id: SENTRY_ISSUE_ID,
            [TQ_ORIGINAL_CONTENT_KEY]: 'encoded-original-content',
          },
        },
        {
          ref: readableRef,
          eventPayload: content.metadata?.event_payload ?? {},
          content,
        },
      ]),
    )

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'resolved',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })

    expect(
      observeIssueStateDispatch(
        outcome,
        null,
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      search: null,
      updateCalls: [[readableRef, setSourceAlertResolved(content, true)]],
    })
  })

  it('ignores other Sentry issue actions without searching Slack', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext(notifier), {
      resource: 'issue',
      payload: {
        action: 'assigned',
        data: { issue: { id: SENTRY_ISSUE_ID } },
      },
    })

    expect(
      observeIssueStateDispatch(
        outcome,
        notifier.findMessagesByMetadata.mock.calls,
        notifier.updateMessage.mock.calls,
      ),
    ).toEqual({ outcome: 'ignored', search: [], updateCalls: [] })
  })
})
