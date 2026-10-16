import { createHmac } from 'node:crypto'

import { Webhooks } from '@octokit/webhooks'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import type { TqClient, TqTaskRef } from '#plugins/tq/tq-client'
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
const ACTIVITY_CHANNEL = '#github_activity'
const TQ_WEB_URL = 'https://tq.fohte.net'
const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 42,
}

const createNotifier = () => {
  const postMessage = vi.fn((): ResultAsync<SlackMessageRef, SlackApiError> => {
    return okAsync({ channel: 'C1', ts: '1' })
  })
  const notifier: SlackNotifier = {
    postMessage,
    updateMessage: vi.fn(),
    findMessageByMetadata: vi.fn(),
    uploadImage: vi.fn(),
  }
  return {
    notifier,
    postMessage,
  }
}

const createGithubClient = () => ({
  findPullRequestForCommit: vi.fn().mockReturnValue(okAsync(null)),
  findFailedStep: vi.fn().mockReturnValue(okAsync(null)),
})

const createTqClient = (): TqClient => ({
  createTask: vi.fn(() => okAsync(TQ_TASK_REF)),
})

const createTestApp = (
  notifier: SlackNotifier,
  sentryTqClient: TqClient = createTqClient(),
): ReturnType<typeof createApp> =>
  createApp({
    sources: [
      createGithubSource(
        GITHUB_SECRET,
        ACTIVITY_CHANNEL,
        createGithubClient(),
        createTqClient(),
        TQ_WEB_URL,
      ),
      createSentrySource(SENTRY_SECRET, sentryTqClient, TQ_WEB_URL),
    ],
    notifier,
  })

const signGithubBody = (body: string): Promise<string> =>
  new Webhooks({ secret: GITHUB_SECRET }).sign(body)

const signSentryBody = (body: string): string =>
  createHmac('sha256', SENTRY_SECRET).update(body, 'utf8').digest('hex')

const observePostMessage = <TResult, TCalls>(
  result: TResult,
  postMessageCalls: TCalls,
) => ({ result, postMessageCalls })

const observeWithEvents = <TResult>(result: TResult, events: string[]) => ({
  result,
  events,
})

const githubWorkflowRunFailureBody = JSON.stringify({
  action: 'completed',
  repository: {
    full_name: 'fohte/example',
    owner: { login: 'fohte' },
    name: 'example',
    default_branch: 'main',
  },
  workflow_run: {
    id: 1,
    name: 'CI',
    event: 'push',
    head_branch: 'main',
    head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    head_commit: { message: 'fix: something' },
    display_title: 'fix: something',
    triggering_actor: { login: 'octocat' },
    html_url: 'https://github.com/fohte/example/actions/runs/1',
    conclusion: 'failure',
    head_repository: {
      full_name: 'fohte/example',
    },
  },
})

const githubWorkflowRunFailureContent = {
  text: '🚨 CI failed\n未対応 · <https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42>',
  color: '#d73a49',
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: '🚨 CI failed' } },
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
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '*状態*\n未対応 · <https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42>',
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
    },
  },
  username: 'GitHub CI',
  iconUrl: 'https://avatars.githubusercontent.com/in/15368',
}

const sentryIssueAlertTriggeredBody = JSON.stringify({
  action: 'triggered',
  data: {
    event: {
      title: 'TypeError: Cannot read properties of undefined',
      level: 'error',
      web_url: 'https://sentry.io/organizations/example-org/issues/123/',
      url: 'https://sentry.io/api/0/projects/example-org/sample-app/events/456/',
      culprit: 'src/example.ts in runTask',
    },
    triggered_rule: 'sample-rule',
  },
})

const sentryIssueAlertTriggeredContent = {
  text: '🐛 TypeError: Cannot read properties of undefined\n未対応 · <https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42>',
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
        { type: 'mrkdwn', text: '*発生箇所*\n`src/example.ts in runTask`' },
        { type: 'mrkdwn', text: '*Rule*\nsample-rule' },
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
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '*状態*\n未対応 · <https://tq.fohte.net/tasks/00000000-0000-4000-8000-000000000001|tq #42>',
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
    },
  },
}

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
    expect(postMessage.mock.calls).toEqual([[githubWorkflowRunFailureContent]])
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

    await app.drainBackgroundDispatches()

    expect(observePostMessage(result, postMessage.mock.calls)).toEqual({
      result: {
        status: 200,
        body: { ok: true },
      },
      postMessageCalls: [[sentryIssueAlertTriggeredContent]],
    })
  })

  it('returns a 2xx response before Sentry task creation completes', async () => {
    const taskCreationStarted = Promise.withResolvers<undefined>()
    const taskCreation = Promise.withResolvers<TqTaskRef>()
    const events: string[] = []
    const sentryTqClient: TqClient = {
      createTask: vi.fn(() => {
        events.push('task_creation_started')
        taskCreationStarted.resolve(undefined)
        return ResultAsync.fromSafePromise(taskCreation.promise)
      }),
    }
    const { notifier } = createNotifier()
    const app = createTestApp(notifier, sentryTqClient)

    const resultPromise = requestJson(app, '/sentry', {
      method: 'POST',
      headers: {
        'Request-ID': 'req-1',
        'Sentry-Hook-Resource': 'event_alert',
        'Sentry-Hook-Signature': signSentryBody(sentryIssueAlertTriggeredBody),
      },
      body: sentryIssueAlertTriggeredBody,
    }).then((result) => {
      events.push('response_returned')
      return result
    })
    await taskCreationStarted.promise

    const observation = observeWithEvents(await resultPromise, events)
    taskCreation.resolve(TQ_TASK_REF)
    await app.drainBackgroundDispatches()

    expect(observation).toEqual({
      result: { status: 200, body: { ok: true } },
      events: ['response_returned', 'task_creation_started'],
    })
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
    await app.drainBackgroundDispatches()

    expect(postMessage.mock.calls).toEqual([
      [githubWorkflowRunFailureContent],
      [sentryIssueAlertTriggeredContent],
    ])
  })
})
