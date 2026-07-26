import type { WorkflowRunCompletedEvent } from '@octokit/webhooks-types'

import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface WorkflowRunInput {
  repo: string
  headRepo: string
  workflow: string
  branch: string
  defaultBranch: string
  conclusion: WorkflowRunCompletedEvent['workflow_run']['conclusion']
  sha: string
  url: string
}

export interface WorkflowRunNotification {
  text: string
  repo: string
  workflow: string
  branch: string
  sha: string
  url: string
}

export const extractWorkflowRunInput = (
  payload: WorkflowRunCompletedEvent,
): WorkflowRunInput => ({
  repo: payload.repository.full_name,
  headRepo: payload.workflow_run.head_repository.full_name,
  workflow: payload.workflow_run.name,
  branch: payload.workflow_run.head_branch,
  defaultBranch: payload.repository.default_branch,
  conclusion: payload.workflow_run.conclusion,
  sha: payload.workflow_run.head_sha,
  url: payload.workflow_run.html_url,
})

export const buildWorkflowRunNotification = (
  input: WorkflowRunInput,
): WorkflowRunNotification | null => {
  if (input.conclusion !== 'failure') return null
  // Fork-originated runs surface upstream's `repository.default_branch` with the
  // fork's `head_branch` (often also `main`), which would otherwise pass the branch check.
  if (input.headRepo !== input.repo) return null
  if (input.branch !== input.defaultBranch) return null

  const text = [
    `:rotating_light: *CI failure on \`${escapeSlackMrkdwn(input.repo)}\`*`,
    `Workflow: *${escapeSlackMrkdwn(input.workflow)}* (branch \`${escapeSlackMrkdwn(input.branch)}\`, commit \`${input.sha.slice(0, 7)}\`)`,
    `<${input.url}|View run>`,
  ].join('\n')

  return {
    text,
    repo: input.repo,
    workflow: input.workflow,
    branch: input.branch,
    sha: input.sha,
    url: input.url,
  }
}
