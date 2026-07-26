import { describe, expect, it } from 'vitest'

import type { WorkflowRunInput } from '#sources/github/handlers/workflow-run'
import { buildWorkflowRunNotification } from '#sources/github/handlers/workflow-run'

const baseInput = (
  overrides: Partial<WorkflowRunInput> = {},
): WorkflowRunInput => ({
  repo: 'fohte/example',
  headRepo: 'fohte/example',
  workflow: 'CI',
  branch: 'main',
  defaultBranch: 'main',
  conclusion: 'failure',
  sha: 'abcdef1234567890abcdef1234567890abcdef12',
  url: 'https://github.com/fohte/example/actions/runs/1',
  ...overrides,
})

describe('buildWorkflowRunNotification', () => {
  it('returns a notification for failed runs on the default branch', () => {
    expect(buildWorkflowRunNotification(baseInput())).toEqual({
      text: [
        ':rotating_light: *CI failure on `fohte/example`*',
        'Workflow: *CI* (branch `main`, commit `abcdef1`)',
        '<https://github.com/fohte/example/actions/runs/1|View run>',
      ].join('\n'),
      repo: 'fohte/example',
      workflow: 'CI',
      branch: 'main',
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      url: 'https://github.com/fohte/example/actions/runs/1',
    })
  })

  it('escapes Slack mrkdwn metacharacters in workflow name', () => {
    expect(
      buildWorkflowRunNotification(baseInput({ workflow: 'CI <generics>' })),
    ).toEqual({
      text: [
        ':rotating_light: *CI failure on `fohte/example`*',
        'Workflow: *CI &lt;generics&gt;* (branch `main`, commit `abcdef1`)',
        '<https://github.com/fohte/example/actions/runs/1|View run>',
      ].join('\n'),
      repo: 'fohte/example',
      workflow: 'CI <generics>',
      branch: 'main',
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      url: 'https://github.com/fohte/example/actions/runs/1',
    })
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
  ])('returns null when $name', ({ overrides }) => {
    expect(buildWorkflowRunNotification(baseInput(overrides))).toBeNull()
  })
})
