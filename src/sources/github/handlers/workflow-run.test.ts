import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { GitHubApiError, type GitHubClient } from '#github-client'
import type { SlackBlock } from '#slack'
import type {
  WorkflowRunInput,
  WorkflowRunNotificationDeps,
} from '#sources/github/handlers/workflow-run'
import { buildWorkflowRunNotification } from '#sources/github/handlers/workflow-run'

const baseInput = (
  overrides: Partial<WorkflowRunInput> = {},
): WorkflowRunInput => ({
  repo: 'fohte/example',
  repoOwner: 'fohte',
  repoName: 'example',
  headRepo: 'fohte/example',
  workflow: 'CI',
  branch: 'main',
  defaultBranch: 'main',
  conclusion: 'failure',
  sha: 'abcdef1234567890abcdef1234567890abcdef12',
  runId: 42,
  url: 'https://github.com/fohte/example/actions/runs/1',
  event: 'push',
  displayTitle: 'fix: something',
  commitMessage: 'fix: something\n\nlonger body',
  triggeringActor: 'octocat',
  ...overrides,
})

const createDeps = (
  overrides: {
    pullRequest?: ReturnType<GitHubClient['findPullRequestForCommit']>
    failedStep?: ReturnType<GitHubClient['findFailedStep']>
  } = {},
): WorkflowRunNotificationDeps & {
  githubClient: {
    findPullRequestForCommit: ReturnType<typeof vi.fn>
    findFailedStep: ReturnType<typeof vi.fn>
  }
} => ({
  githubClient: {
    findPullRequestForCommit: vi
      .fn()
      .mockReturnValue(overrides.pullRequest ?? okAsync(null)),
    findFailedStep: vi
      .fn()
      .mockReturnValue(overrides.failedStep ?? okAsync(null)),
  },
})

const headerBlock = (text: string): SlackBlock => ({
  type: 'header',
  text: { type: 'plain_text', text },
})

const sectionBlock = (text: string): SlackBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
})

const contextBlock = (text: string): SlackBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
})

describe('buildWorkflowRunNotification', () => {
  it('links the merged PR title on a push run when one is found', async () => {
    const deps = createDeps({
      pullRequest: okAsync({
        number: 128,
        title: 'Bump aws provider to v5.31.0',
        url: 'https://github.com/fohte/example/pull/128',
      }),
      failedStep: okAsync({ job: 'plan (production)', step: 'terraform plan' }),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual({
      content: {
        text: '🚨 CI failed',
        color: '#d73a49',
        blocks: [
          headerBlock('🚨 CI failed'),
          sectionBlock(
            '<https://github.com/fohte/example/pull/128|#128 Bump aws provider to v5.31.0>',
          ),
          sectionBlock('失敗: `plan (production)` › `terraform plan`'),
          contextBlock(
            'fohte/example · <https://github.com/fohte/example/actions/runs/1|View run>',
          ),
        ],
        username: 'GitHub CI',
        iconUrl: 'https://avatars.githubusercontent.com/in/15368',
      },
      repo: 'fohte/example',
      workflow: 'CI',
      url: 'https://github.com/fohte/example/actions/runs/1',
    })
  })

  it('calls the GitHub API with the commit sha and run id on a push run', async () => {
    const deps = createDeps()

    await buildWorkflowRunNotification(baseInput(), deps)

    expect(
      deps.githubClient.findPullRequestForCommit,
    ).toHaveBeenCalledExactlyOnceWith(
      'fohte',
      'example',
      'abcdef1234567890abcdef1234567890abcdef12',
    )
    expect(deps.githubClient.findFailedStep).toHaveBeenCalledExactlyOnceWith(
      'fohte',
      'example',
      42,
    )
  })

  it('falls back to the commit message first line on a push run when no PR is found', async () => {
    const deps = createDeps()

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual({
      content: {
        text: '🚨 CI failed',
        color: '#d73a49',
        blocks: [
          headerBlock('🚨 CI failed'),
          sectionBlock('fix: something'),
          contextBlock(
            'fohte/example · <https://github.com/fohte/example/actions/runs/1|View run>',
          ),
        ],
        username: 'GitHub CI',
        iconUrl: 'https://avatars.githubusercontent.com/in/15368',
      },
      repo: 'fohte/example',
      workflow: 'CI',
      url: 'https://github.com/fohte/example/actions/runs/1',
    })
  })

  it('falls back to the commit message when the PR lookup fails', async () => {
    const deps = createDeps({
      pullRequest: errAsync(new GitHubApiError('boom', undefined)),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()?.content.blocks).toEqual([
      headerBlock('🚨 CI failed'),
      sectionBlock('fix: something'),
      contextBlock(
        'fohte/example · <https://github.com/fohte/example/actions/runs/1|View run>',
      ),
    ])
  })

  it('omits the body line and skips the PR lookup for a schedule run', async () => {
    const deps = createDeps({
      failedStep: okAsync({ job: 'sync', step: 'Run template sync' }),
    })

    const result = await buildWorkflowRunNotification(
      baseInput({ event: 'schedule', workflow: 'Boilerplate update' }),
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual({
      content: {
        text: '🚨 Boilerplate update failed',
        color: '#d73a49',
        blocks: [
          headerBlock('🚨 Boilerplate update failed'),
          sectionBlock('失敗: `sync` › `Run template sync`'),
          contextBlock(
            'fohte/example · 定期実行 · <https://github.com/fohte/example/actions/runs/1|View run>',
          ),
        ],
        username: 'GitHub CI',
        iconUrl: 'https://avatars.githubusercontent.com/in/15368',
      },
      repo: 'fohte/example',
      workflow: 'Boilerplate update',
      url: 'https://github.com/fohte/example/actions/runs/1',
    })
    expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
  })

  it('omits the body line and names the actor for a workflow_dispatch run', async () => {
    const deps = createDeps()

    const result = await buildWorkflowRunNotification(
      baseInput({ event: 'workflow_dispatch', triggeringActor: 'octocat' }),
      deps,
    )

    expect(result._unsafeUnwrap()?.content.blocks).toEqual([
      headerBlock('🚨 CI failed'),
      contextBlock(
        'fohte/example · `@octocat` が手動実行 · <https://github.com/fohte/example/actions/runs/1|View run>',
      ),
    ])
    expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
  })

  it('uses the display title and names the triggering event for other event types', async () => {
    const deps = createDeps()

    const result = await buildWorkflowRunNotification(
      baseInput({
        event: 'issue_comment',
        displayTitle: 'Bump aws provider (#42)',
      }),
      deps,
    )

    expect(result._unsafeUnwrap()?.content.blocks).toEqual([
      headerBlock('🚨 CI failed'),
      sectionBlock('Bump aws provider (#42)'),
      contextBlock(
        'fohte/example · `issue_comment` 起因 · <https://github.com/fohte/example/actions/runs/1|View run>',
      ),
    ])
    expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
  })

  it('escapes Slack mrkdwn metacharacters in the PR title', async () => {
    const deps = createDeps({
      pullRequest: okAsync({
        number: 1,
        title: 'Bump <generics> & things',
        url: 'https://github.com/fohte/example/pull/1',
      }),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()?.content.blocks).toEqual([
      headerBlock('🚨 CI failed'),
      sectionBlock(
        '<https://github.com/fohte/example/pull/1|#1 Bump &lt;generics&gt; &amp; things>',
      ),
      contextBlock(
        'fohte/example · <https://github.com/fohte/example/actions/runs/1|View run>',
      ),
    ])
  })

  it.each([
    {
      name: 'conclusion is success',
      overrides: { conclusion: 'success' as const },
    },
    {
      name: 'conclusion is cancelled',
      overrides: { conclusion: 'cancelled' as const },
    },
    {
      name: 'head branch is not the default',
      overrides: { branch: 'feature/x' },
    },
    {
      name: 'head repository differs from the receiving repository (fork)',
      overrides: { headRepo: 'someone/example' },
    },
  ])(
    'returns null without calling the GitHub API when $name',
    async ({ overrides }) => {
      const deps = createDeps()

      const result = await buildWorkflowRunNotification(
        baseInput(overrides),
        deps,
      )

      expect(result._unsafeUnwrap()).toBeNull()
      expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
      expect(deps.githubClient.findFailedStep).not.toHaveBeenCalled()
    },
  )
})
