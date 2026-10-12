import { describe, expect, it } from 'vitest'

import { loadConfig } from '#config'

const ENV = {
  GITHUB_WEBHOOK_SECRET: 'github-secret',
  SENTRY_WEBHOOK_SECRET: 'sentry-secret',
  GRAFANA_WEBHOOK_SECRET: 'grafana-secret',
  SLACK_BOT_TOKEN: 'xoxb-example-token',
  TQ_API_URL: 'https://tasks.example.test',
  OCTO_STS_URL: 'https://octo.example.test',
  OCTO_STS_SCOPE: 'example-org',
  OCTO_STS_IDENTITY: 'webhook-hub',
}

describe('loadConfig', () => {
  it('loads the Grafana secret with the existing service configuration', () => {
    expect(loadConfig(ENV)._unsafeUnwrap()).toEqual({
      githubWebhookSecret: 'github-secret',
      sentryWebhookSecret: 'sentry-secret',
      grafanaWebhookSecret: 'grafana-secret',
      slackBotToken: 'xoxb-example-token',
      slackChannel: '#infra_alert',
      slackActivityChannel: '#activity',
      tqApiUrl: 'https://tasks.example.test',
      tqWebUrl: 'https://tq.fohte.net',
      port: 8080,
      octoSts: {
        url: 'https://octo.example.test',
        scope: 'example-org',
        identity: 'webhook-hub',
        saTokenPath: '/var/run/secrets/tokens/octo-sts-token',
      },
    })
  })

  it('requires GRAFANA_WEBHOOK_SECRET', () => {
    const env = Object.fromEntries(
      Object.entries(ENV).filter(([name]) => name !== 'GRAFANA_WEBHOOK_SECRET'),
    )
    expect(loadConfig(env).isErr()).toBe(true)
  })
})
