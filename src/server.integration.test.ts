import { createHmac } from 'node:crypto'

import { Webhooks } from '@octokit/webhooks'
import type { Hono } from 'hono'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '#server'
import { requestJson, requestText } from '#server-test-support'
import type { SlackMessageRef, SlackNotifier } from '#slack'
import { SlackApiError } from '#slack'
import { createGithubSource } from '#sources/github/index'
import { createSentrySource } from '#sources/sentry/index'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const GITHUB_SECRET = 'github-test-secret'
const SENTRY_SECRET = 'sentry-test-secret'

const createNotifier = () => {
  const postMessage = vi.fn((): ResultAsync<SlackMessageRef, SlackApiError> =>
    okAsync({ channel: 'C1', ts: '1' }),
  )
  const notifier: SlackNotifier = {
    postMessage,
    updateMessage: vi.fn(),
    findMessageByMetadata: vi.fn(),
  }
  return { notifier, postMessage }
}

const createTestApp = (notifier: SlackNotifier): Hono =>
  createApp({
    sources: [
      createGithubSource(GITHUB_SECRET),
      createSentrySource(SENTRY_SECRET),
    ],
    notifier,
  })

const signGithubBody = (body: string): Promise<string> =>
  new Webhooks({ secret: GITHUB_SECRET }).sign(body)

const signSentryBody = (body: string): string =>
  createHmac('sha256', SENTRY_SECRET).update(body, 'utf8').digest('hex')

const githubWorkflowRunFailureBody = JSON.stringify({
  action: 'completed',
  repository: {
    full_name: 'fohte/example',
    default_branch: 'main',
  },
  workflow_run: {
    name: 'CI',
    head_branch: 'main',
    head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    html_url: 'https://github.com/fohte/example/actions/runs/1',
    conclusion: 'failure',
    head_repository: {
      full_name: 'fohte/example',
    },
  },
})

const githubWorkflowRunFailureText = [
  ':rotating_light: *CI failure on `fohte/example`*',
  'Workflow: *CI* (branch `main`, commit `abcdef1`)',
  '<https://github.com/fohte/example/actions/runs/1|View run>',
].join('\n')

const sentryIssueAlertTriggeredBody = JSON.stringify({
  action: 'triggered',
  data: {
    event: {
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      web_url: 'https://sentry.io/organizations/fohte/issues/1/',
    },
    triggered_rule: 'Production errors',
  },
})

const sentryIssueAlertTriggeredText = [
  ':rotating_light: *Sentry alert: TypeError: Cannot read properties of undefined*',
  'Level: *error* / Rule: *Production errors*',
  '<https://sentry.io/organizations/fohte/issues/1/|View issue>',
].join('\n')

describe('createApp with the real GitHub and Sentry sources', () => {
  it('notifies Slack for POST /github with a valid signature and a workflow_run failure on the default branch', async () => {
    const { notifier, postMessage } = createNotifier()
    const app = createTestApp(notifier)
    const body = githubWorkflowRunFailureBody

    const result = await requestJson(app, '/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-1',
        'X-GitHub-Event': 'workflow_run',
        'X-Hub-Signature-256': await signGithubBody(body),
      },
      body,
    })

    expect(result).toEqual({
      status: 200,
      body: { ok: true, outcome: 'notified' },
    })
    expect(postMessage.mock.calls).toEqual([
      [{ text: githubWorkflowRunFailureText }],
    ])
  })

  it('notifies Slack for POST /sentry with a valid signature and a triggered event_alert', async () => {
    const { notifier, postMessage } = createNotifier()
    const app = createTestApp(notifier)
    const body = sentryIssueAlertTriggeredBody

    const result = await requestJson(app, '/sentry', {
      method: 'POST',
      headers: {
        'Request-ID': 'req-1',
        'Sentry-Hook-Resource': 'event_alert',
        'Sentry-Hook-Signature': signSentryBody(body),
      },
      body,
    })

    expect(result).toEqual({
      status: 200,
      body: { ok: true, outcome: 'notified' },
    })
    expect(postMessage.mock.calls).toEqual([
      [{ text: sentryIssueAlertTriggeredText }],
    ])
  })

  it('returns 404 for a path with no registered source', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)

    const result = await requestText(app, '/unknown', {
      method: 'POST',
      body: '{}',
    })

    expect(result).toEqual({ status: 404, body: '404 Not Found' })
  })

  it('returns 401 for POST /github when the signature is invalid', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)

    const result = await requestJson(app, '/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-1',
        'X-GitHub-Event': 'workflow_run',
        'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
      },
      body: githubWorkflowRunFailureBody,
    })

    expect(result).toEqual({
      status: 401,
      body: { error: 'invalid signature' },
    })
  })

  it('returns 400 for POST /github when required headers are missing', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)

    const result = await requestJson(app, '/github', {
      method: 'POST',
      body: githubWorkflowRunFailureBody,
    })

    expect(result).toEqual({
      status: 400,
      body: { error: 'missing required headers' },
    })
  })

  it('returns 400 for POST /github when the body is not valid JSON', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)
    const body = 'not json'

    const result = await requestJson(app, '/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-1',
        'X-GitHub-Event': 'workflow_run',
        'X-Hub-Signature-256': await signGithubBody(body),
      },
      body,
    })

    expect(result).toEqual({ status: 400, body: { error: 'invalid json' } })
  })

  it('returns 401 for POST /sentry when the signature is invalid', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)

    const result = await requestJson(app, '/sentry', {
      method: 'POST',
      headers: {
        'Request-ID': 'req-1',
        'Sentry-Hook-Resource': 'event_alert',
        'Sentry-Hook-Signature': '0'.repeat(64),
      },
      body: sentryIssueAlertTriggeredBody,
    })

    expect(result).toEqual({
      status: 401,
      body: { error: 'invalid signature' },
    })
  })

  it('returns 400 for POST /sentry when required headers are missing', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)

    const result = await requestJson(app, '/sentry', {
      method: 'POST',
      body: sentryIssueAlertTriggeredBody,
    })

    expect(result).toEqual({
      status: 400,
      body: { error: 'missing required headers' },
    })
  })

  it('returns 400 for POST /sentry when the body is not valid JSON', async () => {
    const { notifier } = createNotifier()
    const app = createTestApp(notifier)
    const body = 'not json'

    const result = await requestJson(app, '/sentry', {
      method: 'POST',
      headers: {
        'Request-ID': 'req-1',
        'Sentry-Hook-Resource': 'event_alert',
        'Sentry-Hook-Signature': signSentryBody(body),
      },
      body,
    })

    expect(result).toEqual({ status: 400, body: { error: 'invalid json' } })
  })

  it('isolates a dispatch failure in the GitHub source from the Sentry source', async () => {
    const { notifier, postMessage } = createNotifier()
    postMessage.mockReturnValueOnce(errAsync(new SlackApiError('boom')))
    const app = createTestApp(notifier)

    const githubBody = githubWorkflowRunFailureBody
    await requestJson(app, '/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Delivery': 'delivery-1',
        'X-GitHub-Event': 'workflow_run',
        'X-Hub-Signature-256': await signGithubBody(githubBody),
      },
      body: githubBody,
    })

    const sentryBody = sentryIssueAlertTriggeredBody
    await requestJson(app, '/sentry', {
      method: 'POST',
      headers: {
        'Request-ID': 'req-1',
        'Sentry-Hook-Resource': 'event_alert',
        'Sentry-Hook-Signature': signSentryBody(sentryBody),
      },
      body: sentryBody,
    })

    expect(postMessage.mock.calls).toEqual([
      [{ text: githubWorkflowRunFailureText }],
      [{ text: sentryIssueAlertTriggeredText }],
    ])
  })
})
