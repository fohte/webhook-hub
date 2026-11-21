import { EnvValidationError } from '@fohte/service-kit/env'
import { err } from 'neverthrow'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '#config'

const ENV = {
  GITHUB_WEBHOOK_SECRET: 'github-secret',
  SENTRY_WEBHOOK_SECRET: 'sentry-secret',
  GRAFANA_WEBHOOK_SECRET: 'grafana-secret',
  TQ_WEBHOOK_SECRET: 'tq-secret',
  SLACK_BOT_TOKEN: 'xoxb-example-token',
  TQ_API_URL: 'https://tasks.example.test',
  OCTO_STS_URL: 'https://octo.example.test',
  OCTO_STS_SCOPE: 'example-org',
  OCTO_STS_IDENTITY: 'webhook-hub',
}

const expectedConfig = (
  grafanaApiToken = '',
  grafanaUrl = 'https://fohte.grafana.net',
  ciAlertRules: { repo: string; branch: string; actor?: string }[] = [],
) => ({
  githubWebhookSecret: 'github-secret',
  sentryWebhookSecret: 'sentry-secret',
  grafanaWebhookSecret: 'grafana-secret',
  tqWebhookSecret: 'tq-secret',
  grafanaUrl,
  grafanaApiToken,
  slackBotToken: 'xoxb-example-token',
  slackChannel: '#infra_alert',
  slackActivityChannel: '#activity',
  tqApiUrl: 'https://tasks.example.test',
  tqWebUrl: 'https://tq.fohte.net',
  port: 8080,
  ciAlertRules,
  octoSts: {
    url: 'https://octo.example.test',
    scope: 'example-org',
    identity: 'webhook-hub',
    saTokenPath: '/var/run/secrets/tokens/octo-sts-token',
  },
})

describe('loadConfig', () => {
  it('loads the Grafana secret with the existing service configuration', () => {
    expect(loadConfig(ENV)._unsafeUnwrap()).toEqual(expectedConfig())
  })

  it('loads the configured Grafana panel image settings', () => {
    expect(
      loadConfig({
        ...ENV,
        GRAFANA_API_TOKEN: 'grafana-service-token',
        GRAFANA_URL: 'https://grafana.example.test',
      })._unsafeUnwrap(),
    ).toEqual(
      expectedConfig('grafana-service-token', 'https://grafana.example.test'),
    )
  })

  it('loads configured CI alert rules', () => {
    expect(
      loadConfig({
        ...ENV,
        GITHUB_CI_ALERT_RULES:
          '[{"repo":"sample-org/*","branch":"generated-sync-*","actor":"automation-bot[bot]"}]',
      })._unsafeUnwrap(),
    ).toEqual(
      expectedConfig('', 'https://fohte.grafana.net', [
        {
          repo: 'sample-org/*',
          branch: 'generated-sync-*',
          actor: 'automation-bot[bot]',
        },
      ]),
    )
  })

  it('uses an empty CI alert rule list when configured as an empty array', () => {
    expect(
      loadConfig({ ...ENV, GITHUB_CI_ALERT_RULES: '[]' })._unsafeUnwrap(),
    ).toEqual(expectedConfig())
  })

  it('uses an empty CI alert rule list when unset', () => {
    expect(loadConfig(ENV)._unsafeUnwrap()).toEqual(expectedConfig())
  })

  it.each([
    {
      description: 'invalid JSON',
      value: '[',
      error: 'GITHUB_CI_ALERT_RULES must be valid JSON',
    },
    {
      description: 'an empty string',
      value: '',
      error: 'GITHUB_CI_ALERT_RULES must be valid JSON',
    },
    {
      description: 'a missing branch',
      value: '[{"repo":"sample-org/*"}]',
      error:
        'GITHUB_CI_ALERT_RULES must be an array of rules with string repo and branch and optional string actor',
    },
    {
      description: 'a non-string actor',
      value: '[{"repo":"sample-org/*","branch":"*","actor":2}]',
      error:
        'GITHUB_CI_ALERT_RULES must be an array of rules with string repo and branch and optional string actor',
    },
  ])('rejects $description', ({ value, error }) => {
    expect(loadConfig({ ...ENV, GITHUB_CI_ALERT_RULES: value })).toEqual(
      err(new EnvValidationError([error])),
    )
  })

  it('requires GRAFANA_WEBHOOK_SECRET', () => {
    const env = Object.fromEntries(
      Object.entries(ENV).filter(([name]) => name !== 'GRAFANA_WEBHOOK_SECRET'),
    )
    expect(loadConfig(env).isErr()).toBe(true)
  })

  it('requires TQ_WEBHOOK_SECRET', () => {
    const env = Object.fromEntries(
      Object.entries(ENV).filter(([name]) => name !== 'TQ_WEBHOOK_SECRET'),
    )
    expect(loadConfig(env).isErr()).toBe(true)
  })
})
