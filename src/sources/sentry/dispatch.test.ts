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
    .mockReturnValue(okAsync({ channel: 'C1', ts: '1' })),
  updateMessage: vi
    .fn<DispatchContext['notifier']['updateMessage']>()
    .mockReturnValue(okAsync(undefined)),
  findMessageByMetadata: vi
    .fn<DispatchContext['notifier']['findMessageByMetadata']>()
    .mockReturnValue(okAsync(null)),
  findMessagesByMetadata: vi
    .fn<DispatchContext['notifier']['findMessagesByMetadata']>()
    .mockReturnValue(okAsync([])),
  uploadImage: vi
    .fn<DispatchContext['notifier']['uploadImage']>()
    .mockReturnValue(okAsync('FIMAGE')),
})

const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 42,
}
const TQ_WEB_URL = 'https://tq.fohte.net'
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
): DispatchContext => ({ deliveryId: 'req-1', notifier, tqClient, tqWebUrl })

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
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      web_url: 'https://sentry.io/organizations/example-org/issues/123/',
      url: 'https://sentry.io/api/0/projects/example-org/sample-app/events/456/',
      culprit: 'src/example.ts in runTask',
    },
    triggered_rule: 'Production errors',
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
            text: '🐛 TypeError: Cannot read properties of undefined',
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
            additionalAttachments: [
              {
                text: '<https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42> · todo',
                color: '#2eb67d',
                blocks: [
                  {
                    type: 'context',
                    elements: [
                      {
                        type: 'mrkdwn',
                        text: '<https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42> · todo',
                      },
                    ],
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: '00000000-0000-4000-8000-000000000001',
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
            text: '🐛 TypeError: Cannot read properties of undefined',
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
            metadata: {
              event_type: 'alert_task',
              event_payload: { sentry_issue_id: SENTRY_ISSUE_ID },
            },
          },
        ],
      ],
    })
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
            task_id: '00000000-0000-4000-8000-000000000001',
            sentry_issue_id: SENTRY_ISSUE_ID,
            tq_task_status: 'todo',
            tq_task_status_reason: 'none',
          },
        },
      ],
      updateCalls: [],
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
