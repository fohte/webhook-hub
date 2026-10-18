import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import {
  GitHubApiError,
  GitHubAuthError,
  type GitHubClient,
} from '#github-client'
import type { SlackBlock } from '#slack'
import type {
  WorkflowRunInput,
  WorkflowRunNotificationDeps,
} from '#sources/github/handlers/workflow-run'
import { buildWorkflowRunNotification } from '#sources/github/handlers/workflow-run'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const baseInput = (
  overrides: Partial<WorkflowRunInput> = {},
): WorkflowRunInput => ({
  repo: 'example-owner/example-repo',
  repoOwner: 'example-owner',
  repoName: 'example-repo',
  headRepo: 'example-owner/example-repo',
  workflow: 'CI',
  branch: 'main',
  defaultBranch: 'main',
  workflowId: 101,
  conclusion: 'failure',
  sha: 'b'.repeat(40),
  runId: 42,
  url: 'https://github.com/example-owner/example-repo/actions/runs/42',
  event: 'push',
  displayTitle: 'fix: something',
  commitMessage: 'fix: something\n\nlonger body',
  triggeringActor: 'ci-user',
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

const fieldsBlock = (fields: [string, string][]): SlackBlock => ({
  type: 'section',
  fields: fields.map(([label, value]) => ({
    type: 'mrkdwn',
    text: `*${label}*\n${value}`,
  })),
})

const contextBlock = (text: string): SlackBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
})

const expectedNotification = (
  workflow: string,
  fields: [string, string][],
  failedStep: { job: string; step: string } | null = null,
  options: {
    taskOrigin?: string
    taskTrigger?: string
    taskFailedStep?: string
    defaultBranch?: string
    taskDescriptionWorkflow?: string
  } = {},
) => {
  const {
    taskOrigin = 'fix: something',
    taskTrigger = 'push',
    taskFailedStep,
    defaultBranch = 'main',
    taskDescriptionWorkflow = workflow,
  } = options

  return {
    content: {
      text: `🚨 ${workflow} failed`,
      color: '#d73a49',
      blocks: [
        headerBlock(`🚨 ${workflow} failed`),
        fieldsBlock(fields),
        contextBlock(
          '<https://github.com/example-owner/example-repo/actions/runs/42|View run>',
        ),
      ],
      username: 'GitHub CI',
      iconUrl: 'https://avatars.githubusercontent.com/in/15368',
    },
    task: {
      title: `example-owner/example-repo: ${workflow} が失敗`,
      description: [
        '## なぜやるか',
        '',
        `example-owner/example-repo の ${defaultBranch} で ${taskDescriptionWorkflow} が失敗している。`,
        '',
        `- 起点: ${taskOrigin}`,
        `- トリガー: ${taskTrigger}`,
        '',
        '## やること',
        '',
        '失敗箇所を直す。',
        '',
        `- 失敗箇所: ${taskFailedStep ?? (failedStep === null ? '不明' : `${failedStep.job} / ${failedStep.step}`)}`,
        '- Run: https://github.com/example-owner/example-repo/actions/runs/42',
        '',
        '## 完了条件',
        '',
        `- [ ] ${defaultBranch} の ${taskDescriptionWorkflow} が成功する`,
      ].join('\n'),
      context: 'personal',
      labels: ['alert/ci', 'dev/example-repo'],
    },
    repo: 'example-owner/example-repo',
    workflow,
    url: 'https://github.com/example-owner/example-repo/actions/runs/42',
  }
}

describe('buildWorkflowRunNotification', () => {
  it('links the merged PR title on a push run when one is found', async () => {
    const deps = createDeps({
      pullRequest: okAsync({
        number: 128,
        title: 'Update infrastructure configuration',
        url: 'https://github.com/example-owner/example-repo/pull/128',
      }),
      failedStep: okAsync({
        job: 'plan (production)',
        step: 'terraform plan @0123456789abcdef0123456789abcdef01234567',
      }),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'CI',
        [
          ['Repository', 'example-owner/example-repo'],
          [
            '起点の PR',
            '<https://github.com/example-owner/example-repo/pull/128|#128 Update infrastructure configuration>',
          ],
          [
            '失敗箇所',
            '`plan (production)` › `terraform plan @0123456789abcdef0123456789abcdef01234567`',
          ],
          ['トリガー', 'push'],
        ],
        {
          job: 'plan (production)',
          step: 'terraform plan @0123456789abcdef0123456789abcdef01234567',
        },
        {
          taskOrigin:
            'Update infrastructure configuration https://github.com/example-owner/example-repo/pull/128',
          taskTrigger: 'push',
          taskFailedStep: 'plan (production) / terraform plan',
        },
      ),
    )
  })

  it('calls the GitHub API with the commit sha and run id on a push run', async () => {
    const deps = createDeps()

    await buildWorkflowRunNotification(baseInput(), deps)

    expect(
      deps.githubClient.findPullRequestForCommit,
    ).toHaveBeenCalledExactlyOnceWith(
      'example-owner',
      'example-repo',
      'b'.repeat(40),
    )
    expect(deps.githubClient.findFailedStep).toHaveBeenCalledExactlyOnceWith(
      'example-owner',
      'example-repo',
      42,
    )
  })

  it('falls back to the commit message first line on a push run when no PR is found', async () => {
    const deps = createDeps()

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification('CI', [
        ['Repository', 'example-owner/example-repo'],
        ['起点の PR', 'fix: something'],
        ['失敗箇所', '不明'],
        ['トリガー', 'push'],
      ]),
    )
  })

  it('falls back to the commit message when the PR lookup fails', async () => {
    const deps = createDeps({
      pullRequest: errAsync(new GitHubApiError('boom', undefined)),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification('CI', [
        ['Repository', 'example-owner/example-repo'],
        ['起点の PR', 'fix: something'],
        ['失敗箇所', '不明'],
        ['トリガー', 'push'],
      ]),
    )
  })

  it('reports the github-api-lookup-failed fingerprint when the PR lookup fails for a non-auth reason', async () => {
    const lookupError = new GitHubApiError('boom', undefined)
    const deps = createDeps({
      pullRequest: errAsync(lookupError),
    })

    await buildWorkflowRunNotification(baseInput(), deps)

    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [
        lookupError,
        'webhook-hub.github-api-lookup-failed',
        {
          extras: {
            repo: 'example-owner/example-repo',
            sha: 'b'.repeat(40),
          },
        },
      ],
    ])
  })

  it('reports the octo-sts auth-failure fingerprint when the PR lookup fails due to a token error', async () => {
    const lookupError = new GitHubAuthError(
      'failed to obtain a GitHub API token',
      undefined,
    )
    const deps = createDeps({
      pullRequest: errAsync(lookupError),
    })

    await buildWorkflowRunNotification(baseInput(), deps)

    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [
        lookupError,
        'webhook-hub.octo-sts-auth-failed',
        {
          extras: {
            repo: 'example-owner/example-repo',
            sha: 'b'.repeat(40),
          },
        },
      ],
    ])
  })

  it('reports the octo-sts auth-failure fingerprint when the failed-step lookup fails due to a token error', async () => {
    const lookupError = new GitHubAuthError(
      'failed to obtain a GitHub API token',
      undefined,
    )
    const deps = createDeps({
      failedStep: errAsync(lookupError),
    })

    await buildWorkflowRunNotification(baseInput(), deps)

    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [
        lookupError,
        'webhook-hub.octo-sts-auth-failed',
        {
          extras: {
            repo: 'example-owner/example-repo',
            run_id: 42,
          },
        },
      ],
    ])
  })

  it('omits the body line and skips the PR lookup for a schedule run', async () => {
    const deps = createDeps({
      failedStep: okAsync({ job: 'sync', step: 'Run template sync' }),
    })

    const result = await buildWorkflowRunNotification(
      baseInput({
        event: 'schedule',
        workflow: 'Boilerplate update',
        branch: 'stable',
        defaultBranch: 'stable',
      }),
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'Boilerplate update',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'なし'],
          ['失敗箇所', '`sync` › `Run template sync`'],
          ['トリガー', '定期実行'],
        ],
        { job: 'sync', step: 'Run template sync' },
        {
          taskOrigin: 'なし',
          taskTrigger: '定期実行',
          defaultBranch: 'stable',
        },
      ),
    )
    expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
  })

  it('omits the body line and names the actor for a workflow_dispatch run', async () => {
    const deps = createDeps()

    const result = await buildWorkflowRunNotification(
      baseInput({ event: 'workflow_dispatch', triggeringActor: 'ci-user' }),
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'CI',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'なし'],
          ['失敗箇所', '不明'],
          ['トリガー', '`@ci-user` が手動実行'],
        ],
        null,
        { taskOrigin: 'なし', taskTrigger: '@ci-user が手動実行' },
      ),
    )
    expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
  })

  it('uses the display title and names the triggering event for other event types', async () => {
    const deps = createDeps()

    const result = await buildWorkflowRunNotification(
      baseInput({
        event: 'issue_comment',
        displayTitle: 'Update dependency group (#42)',
      }),
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'CI',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'Update dependency group (#42)'],
          ['失敗箇所', '不明'],
          ['トリガー', '`issue_comment` 起因'],
        ],
        null,
        {
          taskOrigin: 'Update dependency group (`#42`)',
          taskTrigger: 'issue_comment 起因',
        },
      ),
    )
    expect(deps.githubClient.findPullRequestForCommit).not.toHaveBeenCalled()
  })

  it('escapes Slack mrkdwn metacharacters in the PR title', async () => {
    const deps = createDeps({
      pullRequest: okAsync({
        number: 1,
        title: 'Update <workflow> & settings',
        url: 'https://github.com/example-owner/example-repo/pull/1',
      }),
    })

    const result = await buildWorkflowRunNotification(
      baseInput({ workflow: 'Build <checks> & Test' }),
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'Build <checks> & Test',
        [
          ['Repository', 'example-owner/example-repo'],
          [
            '起点の PR',
            '<https://github.com/example-owner/example-repo/pull/1|#1 Update &lt;workflow&gt; &amp; settings>',
          ],
          ['失敗箇所', '不明'],
          ['トリガー', 'push'],
        ],
        null,
        {
          taskOrigin:
            'Update &lt;workflow&gt; &amp; settings https://github.com/example-owner/example-repo/pull/1',
          taskDescriptionWorkflow: 'Build &lt;checks&gt; &amp; Test',
        },
      ),
    )
  })

  it('preserves a step name when removing its SHA would leave it empty', async () => {
    const deps = createDeps({
      failedStep: okAsync({ job: 'build', step: '@abcdef1' }),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'CI',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'fix: something'],
          ['失敗箇所', '`build` › `@abcdef1`'],
          ['トリガー', 'push'],
        ],
        { job: 'build', step: '@abcdef1' },
        { taskFailedStep: 'build / @abcdef1' },
      ),
    )
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
      overrides: { headRepo: 'fork-owner/example-repo' },
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
