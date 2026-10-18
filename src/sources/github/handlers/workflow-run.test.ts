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
  taskTitle: string,
  fields: [string, string][],
  taskDescription: string,
) => ({
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
    title: taskTitle,
    description: taskDescription,
    context: 'personal',
    labels: ['alert/ci', 'dev/example-repo'],
  },
  repo: 'example-owner/example-repo',
  workflow,
  url: 'https://github.com/example-owner/example-repo/actions/runs/42',
})

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
        'example-owner/example-repo: CI が失敗',
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
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: Update infrastructure configuration https://github.com/example-owner/example-repo/pull/128
- トリガー: push

## やること

失敗箇所を直す。

- 失敗箇所: \`plan (production)\` › \`terraform plan\`
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
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
      expectedNotification(
        'CI',
        'example-owner/example-repo: CI が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'fix: something'],
          ['失敗箇所', '不明'],
          ['トリガー', 'push'],
        ],
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: fix: something
- トリガー: push

## やること

失敗箇所を直す。

- 失敗箇所: 不明
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
      ),
    )
  })

  it('falls back to the commit message when the PR lookup fails', async () => {
    const deps = createDeps({
      pullRequest: errAsync(new GitHubApiError('boom', undefined)),
    })

    const result = await buildWorkflowRunNotification(baseInput(), deps)

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'CI',
        'example-owner/example-repo: CI が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'fix: something'],
          ['失敗箇所', '不明'],
          ['トリガー', 'push'],
        ],
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: fix: something
- トリガー: push

## やること

失敗箇所を直す。

- 失敗箇所: 不明
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
      ),
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
        'example-owner/example-repo: Boilerplate update が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'なし'],
          ['失敗箇所', '`sync` › `Run template sync`'],
          ['トリガー', '定期実行'],
        ],
        `## なぜやるか

example-owner/example-repo の stable で Boilerplate update が失敗している。

- 起点の PR: なし
- トリガー: 定期実行

## やること

失敗箇所を直す。

- 失敗箇所: \`sync\` › \`Run template sync\`
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] stable の Boilerplate update が成功する`,
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
        'example-owner/example-repo: CI が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'なし'],
          ['失敗箇所', '不明'],
          ['トリガー', '`@ci-user` が手動実行'],
        ],
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: なし
- トリガー: @ci-user が手動実行

## やること

失敗箇所を直す。

- 失敗箇所: 不明
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
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
        'example-owner/example-repo: CI が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'Update dependency group (#42)'],
          ['失敗箇所', '不明'],
          ['トリガー', '`issue_comment` 起因'],
        ],
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: Update dependency group (\`#42\`)
- トリガー: issue_comment 起因

## やること

失敗箇所を直す。

- 失敗箇所: 不明
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
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
        'example-owner/example-repo: Build <checks> & Test が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          [
            '起点の PR',
            '<https://github.com/example-owner/example-repo/pull/1|#1 Update &lt;workflow&gt; &amp; settings>',
          ],
          ['失敗箇所', '不明'],
          ['トリガー', 'push'],
        ],
        `## なぜやるか

example-owner/example-repo の main で Build &lt;checks&gt; &amp; Test が失敗している。

- 起点の PR: Update &lt;workflow&gt; &amp; settings https://github.com/example-owner/example-repo/pull/1
- トリガー: push

## やること

失敗箇所を直す。

- 失敗箇所: 不明
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の Build &lt;checks&gt; &amp; Test が成功する`,
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
        'example-owner/example-repo: CI が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'fix: something'],
          ['失敗箇所', '`build` › `@abcdef1`'],
          ['トリガー', 'push'],
        ],
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: fix: something
- トリガー: push

## やること

失敗箇所を直す。

- 失敗箇所: \`build\` › \`@abcdef1\`
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
      ),
    )
  })

  it('normalizes line breaks in workflow, commit, job, and step names', async () => {
    const deps = createDeps({
      failedStep: okAsync({
        job: 'example-job\r\n## 完了条件',
        step: 'Run example checks\n## なぜやるか @abcdef1',
      }),
    })

    const result = await buildWorkflowRunNotification(
      baseInput({
        workflow: 'Verification\r\n## 完了条件',
        commitMessage: 'fix: sample\r\n## やること\nDetails',
      }),
      deps,
    )

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'Verification\r\n## 完了条件',
        'example-owner/example-repo: Verification ## 完了条件 が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'fix: sample'],
          [
            '失敗箇所',
            '`example-job ## 完了条件` › `Run example checks ## なぜやるか @abcdef1`',
          ],
          ['トリガー', 'push'],
        ],
        `## なぜやるか

example-owner/example-repo の main で Verification ## 完了条件 が失敗している。

- 起点の PR: fix: sample
- トリガー: push

## やること

失敗箇所を直す。

- 失敗箇所: \`example-job ## 完了条件\` › \`Run example checks ## なぜやるか\`
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の Verification ## 完了条件 が成功する`,
      ),
    )
  })

  it('normalizes line breaks in display titles', async () => {
    const result = await buildWorkflowRunNotification(
      baseInput({
        event: 'issue_comment',
        displayTitle: 'Update preview\r\n## やること\nsecond line',
      }),
      createDeps(),
    )

    expect(result._unsafeUnwrap()).toEqual(
      expectedNotification(
        'CI',
        'example-owner/example-repo: CI が失敗',
        [
          ['Repository', 'example-owner/example-repo'],
          ['起点の PR', 'Update preview ## やること second line'],
          ['失敗箇所', '不明'],
          ['トリガー', '`issue_comment` 起因'],
        ],
        `## なぜやるか

example-owner/example-repo の main で CI が失敗している。

- 起点の PR: Update preview ## やること second line
- トリガー: issue_comment 起因

## やること

失敗箇所を直す。

- 失敗箇所: 不明
- Run: https://github.com/example-owner/example-repo/actions/runs/42

## 完了条件

- [ ] main の CI が成功する`,
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
