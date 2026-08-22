import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { SlackApiError } from '#slack'
import type { DispatchContext } from '#sources/github/dispatch'
import { dispatch } from '#sources/github/dispatch'
import type { DispatchOutcome } from '#webhook-source'

const createNotifier = () => ({
  postMessage: vi.fn().mockReturnValue(okAsync({ channel: 'C1', ts: '1' })),
  updateMessage: vi.fn().mockReturnValue(okAsync(undefined)),
  findMessageByMetadata: vi.fn().mockReturnValue(okAsync(null)),
})

const createGithubClient = () => ({
  findPullRequestForCommit: vi.fn().mockReturnValue(okAsync(null)),
  findFailedStep: vi.fn().mockReturnValue(okAsync(null)),
})

const createContext = (
  event: string,
  notifier: DispatchContext['notifier'],
): DispatchContext => ({
  deliveryId: 'delivery-1',
  event,
  notifier,
  activityChannel: '#github_activity',
  githubClient: createGithubClient(),
})

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const workflowRunPayload = (overrides: {
  action?: string
  conclusion?: string
  headRepo?: string
  branch?: string
  defaultBranch?: string
}): unknown => ({
  action: overrides.action ?? 'completed',
  repository: {
    full_name: 'fohte/example',
    owner: { login: 'fohte' },
    name: 'example',
    default_branch: overrides.defaultBranch ?? 'main',
  },
  workflow_run: {
    id: 1,
    name: 'CI',
    event: 'push',
    head_branch: overrides.branch ?? 'main',
    head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    head_commit: { message: 'fix: something' },
    display_title: 'fix: something',
    triggering_actor: { login: 'octocat' },
    html_url: 'https://github.com/fohte/example/actions/runs/1',
    conclusion: overrides.conclusion ?? 'failure',
    head_repository: {
      full_name: overrides.headRepo ?? 'fohte/example',
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

    const outcome = await dispatchOutcome(
      createContext('workflow_run', notifier),
      { name: 'workflow_run', payload: workflowRunPayload({}) },
    )

    expect(outcome).toBe('notified')
    expect(notifier.postMessage).toHaveBeenCalledExactlyOnceWith({
      text: '🚨 CI failed',
      color: '#d73a49',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🚨 CI failed' } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'fix: something' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'fohte/example · <https://github.com/fohte/example/actions/runs/1|View run>',
            },
          ],
        },
      ],
      username: 'GitHub CI',
      iconUrl: 'https://avatars.githubusercontent.com/in/15368',
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

    const outcome = await dispatchOutcome(
      createContext('workflow_run', notifier),
      {
        name: 'workflow_run',
        payload: workflowRunPayload({ conclusion: 'success' }),
      },
    )

    expect(outcome).toBe('filtered')
    expect(notifier.postMessage).not.toHaveBeenCalled()
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
      okAsync({ channel: 'C1', ts: 'existing-ts' }),
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
