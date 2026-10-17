import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task-snapshot'
import { TqApiError, type TqClient } from '#plugins/tq/tq-client'
import {
  SlackApiError,
  type SlackMessageContent,
  type SlackNotifier,
} from '#slack'
import type { DispatchContext } from '#sources/github/dispatch'
import { dispatch } from '#sources/github/dispatch'
import type { DispatchOutcome } from '#webhook-source'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const createNotifier = () => ({
  postMessage: vi
    .fn<SlackNotifier['postMessage']>()
    .mockReturnValue(okAsync({ channel: 'C1', ts: '1' })),
  updateMessage: vi
    .fn<SlackNotifier['updateMessage']>()
    .mockReturnValue(okAsync(undefined)),
  findMessageByMetadata: vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockReturnValue(okAsync(null)),
  uploadImage: vi
    .fn<SlackNotifier['uploadImage']>()
    .mockReturnValue(okAsync('FIMAGE')),
})

const createGithubClient = () => ({
  findPullRequestForCommit: vi.fn().mockReturnValue(okAsync(null)),
  findFailedStep: vi.fn().mockReturnValue(okAsync(null)),
})

const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 42,
}
const TQ_WEB_URL = 'https://tq.fohte.net'

const createTqClient = (
  result: ReturnType<TqClient['createTask']> = okAsync(TQ_TASK_REF),
) => ({
  createTask: vi.fn().mockReturnValue(result),
})

const workflowAlertContent = (options: {
  alertId: string
  runId: number
  repo?: string
  workflowId?: number
  branch?: string
  taskId?: string
  taskNumber?: number
  resolved?: boolean
}): SlackMessageContent => ({
  text: 'CI failed',
  color: '#d73a49',
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: 'CI failed' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Failure details' } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://ci.example.test/runs/42|View run>',
        },
      ],
    },
  ],
  metadata: {
    event_type: 'alert_task',
    event_payload: {
      task_id: options.taskId ?? '00000000-0000-4000-8000-000000000007',
      tq_task_status: 'todo',
      tq_task_status_reason: 'none',
      github_repo: options.repo ?? 'sample-org/ci-app',
      github_workflow_id: options.workflowId ?? 73,
      github_branch: options.branch ?? 'main',
      github_workflow_run_id: options.runId,
      github_alert_id: options.alertId,
      ...(options.resolved === true
        ? { [TQ_ORIGINAL_CONTENT_KEY]: 'stored-snapshot' }
        : {}),
    },
  },
  additionalAttachments: [
    {
      text: `<https://tasks.example.test/tasks/${options.taskId ?? '00000000-0000-4000-8000-000000000007'}|tq #${String(options.taskNumber ?? 7)}> · todo`,
      color: '#2eb67d',
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<https://tasks.example.test/tasks/${options.taskId ?? '00000000-0000-4000-8000-000000000007'}|tq #${String(options.taskNumber ?? 7)}> · todo`,
            },
          ],
        },
      ],
    },
  ],
})

const normalizeAlertContent = (
  content: SlackMessageContent,
): SlackMessageContent => {
  const metadata = content.metadata
  if (metadata === undefined) return content

  const eventPayload = { ...metadata.event_payload }
  if (typeof eventPayload['github_alert_id'] === 'string') {
    eventPayload['github_alert_id'] = 'normalized-alert-id'
  }
  if (typeof eventPayload[TQ_ORIGINAL_CONTENT_KEY] === 'string') {
    eventPayload[TQ_ORIGINAL_CONTENT_KEY] = 'normalized-snapshot'
  }

  return { ...content, metadata: { ...metadata, event_payload: eventPayload } }
}

const normalizePostMessageCalls = (
  calls: Array<[SlackMessageContent]>,
): Array<[SlackMessageContent]> =>
  calls.map(([content]) => [normalizeAlertContent(content)])

const foldedWorkflowAlertContent = (
  content: SlackMessageContent,
): SlackMessageContent => ({
  text: '*~CI failed~*\n<https://ci.example.test/runs/42|View run>',
  color: '#2eb67d',
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*~CI failed~*' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://ci.example.test/runs/42|View run>',
        },
      ],
    },
  ],
  ...(content.metadata === undefined
    ? {}
    : {
        metadata: {
          ...content.metadata,
          event_payload: {
            ...content.metadata.event_payload,
            [TQ_ORIGINAL_CONTENT_KEY]: 'normalized-snapshot',
          },
        },
      }),
  ...(content.additionalAttachments === undefined
    ? {}
    : { additionalAttachments: content.additionalAttachments }),
})

const createContext = (
  event: string,
  notifier: DispatchContext['notifier'],
  tqClient = createTqClient(),
  tqWebUrl = TQ_WEB_URL,
): DispatchContext => ({
  deliveryId: 'delivery-1',
  event,
  notifier,
  activityChannel: '#github_activity',
  githubClient: createGithubClient(),
  tqClient,
  tqWebUrl,
})

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const observeDispatch = <TOutcome, TTaskCalls>(
  outcome: TOutcome,
  taskCalls: TTaskCalls,
  postMessageCalls: Array<[SlackMessageContent]>,
  findMessageCalls: number,
) => ({
  outcome,
  taskCalls,
  postMessageCalls: normalizePostMessageCalls(postMessageCalls),
  findMessageCalls,
})

const observeWorkflowResolution = <TOutcome, TSearchCalls, TTaskCalls>(
  outcome: TOutcome,
  searchCalls: TSearchCalls,
  updateCalls: Array<Parameters<SlackNotifier['updateMessage']>>,
  postMessageCalls: Array<Parameters<SlackNotifier['postMessage']>>,
  taskCalls: TTaskCalls,
) => ({
  outcome,
  searchCalls,
  updateCalls: updateCalls.map(([ref, content]) => [
    ref,
    normalizeAlertContent(content),
  ]),
  postMessageCalls: normalizePostMessageCalls(postMessageCalls),
  taskCalls,
})

const observeFilteredWorkflowRun = (
  outcome: DispatchOutcome,
  notifier: ReturnType<typeof createNotifier>,
  tqClient: ReturnType<typeof createTqClient>,
) => ({
  outcome,
  taskCalls: tqClient.createTask.mock.calls,
  updateCalls: notifier.updateMessage.mock.calls,
  findMessageCalls: notifier.findMessageByMetadata.mock.calls,
  postMessageCalls: notifier.postMessage.mock.calls,
})

const workflowRunPayload = (overrides: {
  action?: string
  conclusion?: string
  headRepo?: string
  branch?: string
  defaultBranch?: string
  repoOwner?: string
  repoName?: string
  repo?: string
  workflowId?: number
  workflowName?: string
  runId?: number
  runUrl?: string
}): unknown => ({
  action: overrides.action ?? 'completed',
  repository: {
    full_name:
      overrides.repo ??
      `${overrides.repoOwner ?? 'fohte'}/${overrides.repoName ?? 'example'}`,
    owner: { login: overrides.repoOwner ?? 'fohte' },
    name: overrides.repoName ?? 'example',
    default_branch: overrides.defaultBranch ?? 'main',
  },
  workflow_run: {
    id: overrides.runId ?? 1,
    workflow_id: overrides.workflowId ?? 101,
    name: overrides.workflowName ?? 'CI',
    event: 'push',
    head_branch: overrides.branch ?? 'main',
    head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    head_commit: { message: 'fix: something' },
    display_title: 'fix: something',
    triggering_actor: { login: 'octocat' },
    html_url:
      overrides.runUrl ?? 'https://github.com/fohte/example/actions/runs/1',
    conclusion: overrides.conclusion ?? 'failure',
    head_repository: {
      full_name:
        overrides.headRepo ??
        overrides.repo ??
        `${overrides.repoOwner ?? 'fohte'}/${overrides.repoName ?? 'example'}`,
    },
  },
})

const securityPullRequestPayload = (overrides: {
  action?: string
  merged?: boolean
}): unknown => ({
  action: overrides.action ?? 'opened',
  repository: { full_name: 'fohte/example' },
  pull_request: {
    title: 'fix(deps): update tauri [security]',
    head: { ref: 'renovate/tauri-vulnerability' },
    html_url: 'https://github.com/fohte/example/pull/1',
    merged: overrides.merged ?? false,
  },
})

const pullRequestPayload = (overrides: {
  action?: string
  senderLogin?: string
  senderType?: string
}): unknown => ({
  action: overrides.action ?? 'opened',
  repository: {
    full_name: 'fohte/example',
    owner: { login: 'fohte' },
  },
  pull_request: {
    title: 'feat: add a thing',
    head: { ref: 'feature/x' },
    html_url: 'https://github.com/fohte/example/pull/2',
    merged: false,
  },
  sender: {
    login: overrides.senderLogin ?? 'octocat',
    type: overrides.senderType ?? 'User',
  },
})

const issuesPayload = (overrides: {
  action?: string
  senderLogin?: string
  senderType?: string
}): unknown => ({
  action: overrides.action ?? 'opened',
  repository: {
    full_name: 'fohte/example',
    owner: { login: 'fohte' },
  },
  issue: {
    title: 'bug: something broke',
    html_url: 'https://github.com/fohte/example/issues/3',
  },
  sender: {
    login: overrides.senderLogin ?? 'octocat',
    type: overrides.senderType ?? 'User',
  },
})

describe('dispatch (workflow_run)', () => {
  it('posts to Slack and returns notified for a failed run on the default branch', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const resolvedAlert = workflowAlertContent({
      alertId: 'already-folded',
      runId: 99,
      resolved: true,
    })
    notifier.findMessageByMetadata.mockReturnValue(
      okAsync({
        ref: { channel: 'C1', ts: 'resolved-alert' },
        eventPayload: resolvedAlert.metadata?.event_payload ?? {},
        content: resolvedAlert,
      }),
    )

    const outcome = await dispatchOutcome(
      createContext(
        'workflow_run',
        notifier,
        tqClient,
        'https://tasks.example.test',
      ),
      { name: 'workflow_run', payload: workflowRunPayload({}) },
    )

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
        notifier.findMessageByMetadata.mock.calls.length,
      ),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title: 'CI failure: CI (fohte/example)',
            description: [
              'Repository: fohte/example',
              'Workflow: CI',
              'Branch: main',
              'Failed step: Unknown',
              'Run: https://github.com/fohte/example/actions/runs/1',
            ].join('\n'),
            context: 'personal',
          },
        ],
      ],
      postMessageCalls: [
        [
          {
            text: '🚨 CI failed',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 CI failed' },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: '*Repository*\nfohte/example' },
                  { type: 'mrkdwn', text: '*起点の PR*\nfix: something' },
                  { type: 'mrkdwn', text: '*失敗箇所*\n不明' },
                  { type: 'mrkdwn', text: '*トリガー*\npush' },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '<https://github.com/fohte/example/actions/runs/1|View run>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                task_id: '00000000-0000-4000-8000-000000000001',
                tq_task_status: 'todo',
                tq_task_status_reason: 'none',
                github_repo: 'fohte/example',
                github_workflow_id: 101,
                github_branch: 'main',
                github_workflow_run_id: 1,
                github_alert_id: 'normalized-alert-id',
              },
            },
            additionalAttachments: [
              {
                text: '<https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000001|tq #42> · todo',
                color: '#2eb67d',
                blocks: [
                  {
                    type: 'context',
                    elements: [
                      {
                        type: 'mrkdwn',
                        text: '<https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000001|tq #42> · todo',
                      },
                    ],
                  },
                ],
              },
            ],
            username: 'GitHub CI',
            iconUrl: 'https://avatars.githubusercontent.com/in/15368',
          },
        ],
      ],
      findMessageCalls: 0,
    })
  })

  it('posts the CI alert without a task link when tq task creation fails', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient(
      errAsync(new TqApiError('TQ API unavailable', undefined)),
    )

    const outcome = await dispatchOutcome(
      createContext('workflow_run', notifier, tqClient),
      { name: 'workflow_run', payload: workflowRunPayload({}) },
    )

    expect(
      observeDispatch(
        outcome,
        tqClient.createTask.mock.calls,
        notifier.postMessage.mock.calls,
        notifier.findMessageByMetadata.mock.calls.length,
      ),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title: 'CI failure: CI (fohte/example)',
            description: [
              'Repository: fohte/example',
              'Workflow: CI',
              'Branch: main',
              'Failed step: Unknown',
              'Run: https://github.com/fohte/example/actions/runs/1',
            ].join('\n'),
            context: 'personal',
          },
        ],
      ],
      postMessageCalls: [
        [
          {
            text: '🚨 CI failed',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 CI failed' },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: '*Repository*\nfohte/example' },
                  { type: 'mrkdwn', text: '*起点の PR*\nfix: something' },
                  { type: 'mrkdwn', text: '*失敗箇所*\n不明' },
                  { type: 'mrkdwn', text: '*トリガー*\npush' },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '<https://github.com/fohte/example/actions/runs/1|View run>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'alert_task',
              event_payload: {
                github_repo: 'fohte/example',
                github_workflow_id: 101,
                github_branch: 'main',
                github_workflow_run_id: 1,
                github_alert_id: 'normalized-alert-id',
              },
            },
            username: 'GitHub CI',
            iconUrl: 'https://avatars.githubusercontent.com/in/15368',
          },
        ],
      ],
      findMessageCalls: 0,
    })
  })

  it('folds every unresolved alert for the successful repo workflow and branch', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const firstAlert = workflowAlertContent({
      alertId: 'alert-first',
      runId: 401,
      taskId: '00000000-0000-4000-8000-000000000041',
      taskNumber: 41,
    })
    const secondAlert = workflowAlertContent({
      alertId: 'alert-second',
      runId: 402,
      taskId: '00000000-0000-4000-8000-000000000042',
      taskNumber: 42,
    })
    const alreadyFoldedAlert = workflowAlertContent({
      alertId: 'alert-folded',
      runId: 400,
      resolved: true,
    })
    const otherBranchAlert = workflowAlertContent({
      alertId: 'alert-other-branch',
      runId: 403,
      branch: 'release',
    })
    const otherWorkflowAlert = workflowAlertContent({
      alertId: 'alert-other-workflow',
      runId: 404,
      workflowId: 74,
    })
    const otherRepoAlert = workflowAlertContent({
      alertId: 'alert-other-repo',
      runId: 405,
      repo: 'sample-org/other-app',
    })
    const messages = [
      {
        eventType: 'alert_task',
        ref: { channel: 'C1', ts: 'first-alert' },
        eventPayload: firstAlert.metadata?.event_payload ?? {},
        content: firstAlert,
      },
      {
        eventType: 'alert_task',
        ref: { channel: 'C1', ts: 'second-alert' },
        eventPayload: secondAlert.metadata?.event_payload ?? {},
        content: secondAlert,
      },
      {
        eventType: 'alert_task',
        ref: { channel: 'C1', ts: 'folded-alert' },
        eventPayload: alreadyFoldedAlert.metadata?.event_payload ?? {},
        content: alreadyFoldedAlert,
      },
      {
        eventType: 'alert_task',
        ref: { channel: 'C1', ts: 'other-branch-alert' },
        eventPayload: otherBranchAlert.metadata?.event_payload ?? {},
        content: otherBranchAlert,
      },
      {
        eventType: 'alert_task',
        ref: { channel: 'C1', ts: 'other-workflow-alert' },
        eventPayload: otherWorkflowAlert.metadata?.event_payload ?? {},
        content: otherWorkflowAlert,
      },
      {
        eventType: 'alert_task',
        ref: { channel: 'C1', ts: 'other-repo-alert' },
        eventPayload: otherRepoAlert.metadata?.event_payload ?? {},
        content: otherRepoAlert,
      },
    ]
    const searchCalls: Array<{
      eventTypes: string[]
      matchingAlertIds: string[]
    }> = []
    notifier.findMessageByMetadata.mockImplementation(
      (
        eventType: string | readonly string[],
        payloadMatcher: (payload: Record<string, unknown>) => boolean,
      ) => {
        const eventTypes =
          typeof eventType === 'string' ? [eventType] : [...eventType]
        const matches = messages.filter(
          (message) =>
            eventTypes.includes(message.eventType) &&
            payloadMatcher(message.eventPayload),
        )
        searchCalls.push({
          eventTypes,
          matchingAlertIds: matches.map((message) =>
            String(message.eventPayload['github_alert_id']),
          ),
        })
        const match = matches[0]
        return okAsync(
          match === undefined
            ? null
            : {
                ref: match.ref,
                eventPayload: match.eventPayload,
                content: match.content,
              },
        )
      },
    )
    notifier.updateMessage.mockImplementation(
      (ref: { channel: string; ts: string }, content: SlackMessageContent) => {
        const message = messages.find(
          (candidate) => candidate.ref.ts === ref.ts,
        )
        if (message !== undefined) {
          message.content = content
          message.eventPayload = content.metadata?.event_payload ?? {}
        }
        return okAsync(undefined)
      },
    )

    const outcome = await dispatchOutcome(
      createContext('workflow_run', notifier, tqClient),
      {
        name: 'workflow_run',
        payload: workflowRunPayload({
          conclusion: 'success',
          repoOwner: 'sample-org',
          repoName: 'ci-app',
          workflowId: 73,
          workflowName: 'CI Pipeline',
          runId: 500,
          runUrl: 'https://github.com/sample-org/ci-app/actions/runs/500',
        }),
      },
    )

    expect(
      observeWorkflowResolution(
        outcome,
        searchCalls,
        notifier.updateMessage.mock.calls,
        notifier.postMessage.mock.calls,
        tqClient.createTask.mock.calls,
      ),
    ).toEqual({
      outcome: 'notified',
      searchCalls: [
        {
          eventTypes: ['alert_task'],
          matchingAlertIds: ['alert-first', 'alert-second'],
        },
        { eventTypes: ['alert_task'], matchingAlertIds: ['alert-second'] },
        { eventTypes: ['alert_task'], matchingAlertIds: [] },
      ],
      updateCalls: [
        [
          { channel: 'C1', ts: 'first-alert' },
          normalizeAlertContent(foldedWorkflowAlertContent(firstAlert)),
        ],
        [
          { channel: 'C1', ts: 'second-alert' },
          normalizeAlertContent(foldedWorkflowAlertContent(secondAlert)),
        ],
      ],
      postMessageCalls: [],
      taskCalls: [],
    })
  })

  it('returns ignored without posting when the action is not completed', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('workflow_run', notifier),
      {
        name: 'workflow_run',
        payload: workflowRunPayload({ action: 'requested' }),
      },
    )

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns filtered without posting for a run outside the notification criteria', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()

    const outcome = await dispatchOutcome(
      createContext('workflow_run', notifier, tqClient),
      {
        name: 'workflow_run',
        payload: workflowRunPayload({
          conclusion: 'success',
          branch: 'feature/temporary',
        }),
      },
    )

    expect(observeFilteredWorkflowRun(outcome, notifier, tqClient)).toEqual({
      outcome: 'filtered',
      taskCalls: [],
      updateCalls: [],
      findMessageCalls: [],
      postMessageCalls: [],
    })
  })
})

describe('dispatch (pull_request)', () => {
  it('posts to Slack and returns notified when a security PR is opened', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: securityPullRequestPayload({ action: 'opened' }),
      },
    )

    expect(outcome).toBe('notified')
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: [
        ':lock: *Security PR opened on `fohte/example`*',
        '*fix(deps): update tauri [security]*',
        '<https://github.com/fohte/example/pull/1|View pull request>',
      ].join('\n'),
      color: '#36a64f',
      metadata: {
        event_type: 'security_pr',
        event_payload: { pr_url: 'https://github.com/fohte/example/pull/1' },
      },
    })
    expect(notifier.findMessageByMetadata).not.toHaveBeenCalled()
  })

  it('updates the existing Slack message when a security PR is closed and one is found', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(
      okAsync({
        ref: { channel: 'C1', ts: 'existing-ts' },
        eventPayload: {
          pr_url: 'https://code.example.test/team/demo/pull/7',
        },
      }),
    )

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: securityPullRequestPayload({
          action: 'closed',
          merged: true,
        }),
      },
    )

    expect(outcome).toBe('notified')
    expect(notifier.updateMessage).toHaveBeenCalledExactlyOnceWith(
      { channel: 'C1', ts: 'existing-ts' },
      {
        text: [
          ':lock: *Security PR merged on `fohte/example`*',
          '*fix(deps): update tauri [security]*',
          '<https://github.com/fohte/example/pull/1|View pull request>',
        ].join('\n'),
        color: '#6f42c1',
        metadata: {
          event_type: 'security_pr',
          event_payload: {
            pr_url: 'https://github.com/fohte/example/pull/1',
          },
        },
      },
    )
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('falls back to posting a new Slack message when a security PR is closed and no original is found', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(okAsync(null))

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: securityPullRequestPayload({
          action: 'closed',
          merged: false,
        }),
      },
    )

    expect(outcome).toBe('notified')
    expect(notifier.updateMessage).not.toHaveBeenCalled()
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: [
        ':lock: *Security PR closed on `fohte/example`*',
        '*fix(deps): update tauri [security]*',
        '<https://github.com/fohte/example/pull/1|View pull request>',
      ].join('\n'),
      color: '#d73a49',
      metadata: {
        event_type: 'security_pr',
        event_payload: { pr_url: 'https://github.com/fohte/example/pull/1' },
      },
    })
  })

  it('returns ignored without posting for an unrelated action', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: securityPullRequestPayload({ action: 'synchronize' }),
      },
    )

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('posts to the activity channel and returns notified when a third-party pull request is opened', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      { name: 'pull_request', payload: pullRequestPayload({}) },
    )

    expect(outcome).toBe('notified')
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: [
        ':speech_balloon: *New pull request opened on `fohte/example` by `octocat`*',
        '*feat: add a thing*',
        '<https://github.com/fohte/example/pull/2|View pull request>',
      ].join('\n'),
      channel: '#github_activity',
    })
  })

  it('returns filtered without posting when a pull request is opened by a bot', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: pullRequestPayload({
          senderLogin: 'renovate[bot]',
          senderType: 'Bot',
        }),
      },
    )

    expect(outcome).toBe('filtered')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns filtered without posting when a pull request is opened by the repository owner', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: pullRequestPayload({ senderLogin: 'fohte' }),
      },
    )

    expect(outcome).toBe('filtered')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns filtered without posting when a third-party pull request is closed', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(
      createContext('pull_request', notifier),
      {
        name: 'pull_request',
        payload: pullRequestPayload({ action: 'closed' }),
      },
    )

    expect(outcome).toBe('filtered')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('propagates a findMessageByMetadata failure without posting or updating', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(
      errAsync(new SlackApiError('boom')),
    )

    const result = await dispatch(createContext('pull_request', notifier), {
      name: 'pull_request',
      payload: securityPullRequestPayload({
        action: 'closed',
        merged: true,
      }),
    })

    expect(result._unsafeUnwrapErr()).toEqual(new SlackApiError('boom'))
    expect(notifier.updateMessage).not.toHaveBeenCalled()
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })
})

const starPayload = (overrides: { action?: string }): unknown => ({
  action: overrides.action ?? 'created',
  repository: {
    full_name: 'fohte/example',
    html_url: 'https://github.com/fohte/example',
  },
  sender: { login: 'octocat' },
})

describe('dispatch (star)', () => {
  it('posts to the activity channel and returns notified when a repository is starred', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('star', notifier), {
      name: 'star',
      payload: starPayload({}),
    })

    expect(outcome).toBe('notified')
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: [
        ':star: *`fohte/example` was starred by `octocat`*',
        '<https://github.com/fohte/example|View repository>',
      ].join('\n'),
      channel: '#github_activity',
    })
  })

  it('returns ignored without posting when the star is removed', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('star', notifier), {
      name: 'star',
      payload: starPayload({ action: 'deleted' }),
    })

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })
})

describe('dispatch (issues)', () => {
  it('posts to the activity channel and returns notified when a third-party issue is opened', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('issues', notifier), {
      name: 'issues',
      payload: issuesPayload({}),
    })

    expect(outcome).toBe('notified')
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: [
        ':speech_balloon: *New issue opened on `fohte/example` by `octocat`*',
        '*bug: something broke*',
        '<https://github.com/fohte/example/issues/3|View issue>',
      ].join('\n'),
      channel: '#github_activity',
    })
  })

  it('returns filtered without posting when an issue is opened by a bot', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('issues', notifier), {
      name: 'issues',
      payload: issuesPayload({
        senderLogin: 'dependabot[bot]',
        senderType: 'Bot',
      }),
    })

    expect(outcome).toBe('filtered')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns filtered without posting when an issue is opened by the repository owner', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('issues', notifier), {
      name: 'issues',
      payload: issuesPayload({ senderLogin: 'fohte' }),
    })

    expect(outcome).toBe('filtered')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })

  it('returns ignored without posting for an unrelated action', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('issues', notifier), {
      name: 'issues',
      payload: issuesPayload({ action: 'closed' }),
    })

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })
})

describe('dispatch (unrecognized event)', () => {
  it('returns ignored without posting', async () => {
    const notifier = createNotifier()

    const outcome = await dispatchOutcome(createContext('ping', notifier), {
      name: 'ping',
      payload: {},
    })

    expect(outcome).toBe('ignored')
    expect(notifier.postMessage).not.toHaveBeenCalled()
  })
})
