import {
  type EnvSource,
  type EnvValidationError,
  optionalInt,
  optionalString,
  parseEnv,
  requireString,
} from '@fohte/service-kit/env'
import type { OctoStsConfig } from '@fohte/service-kit/octo-sts'
import type { Result } from 'neverthrow'

export interface Config {
  githubWebhookSecret: string
  sentryWebhookSecret: string
  grafanaWebhookSecret: string
  grafanaApiToken: string
  slackBotToken: string
  slackChannel: string
  slackActivityChannel: string
  tqApiUrl: string
  tqWebUrl: string
  port: number
  octoSts: OctoStsConfig
}

export const loadConfig = (
  env: EnvSource = process.env,
): Result<Config, EnvValidationError> =>
  parseEnv({
    githubWebhookSecret: requireString(env, 'GITHUB_WEBHOOK_SECRET'),
    sentryWebhookSecret: requireString(env, 'SENTRY_WEBHOOK_SECRET'),
    grafanaWebhookSecret: requireString(env, 'GRAFANA_WEBHOOK_SECRET'),
    grafanaApiToken: optionalString(env, 'GRAFANA_API_TOKEN', ''),
    slackBotToken: requireString(env, 'SLACK_BOT_TOKEN'),
    slackChannel: optionalString(env, 'SLACK_CHANNEL', '#infra_alert'),
    slackActivityChannel: optionalString(
      env,
      'SLACK_ACTIVITY_CHANNEL',
      '#activity',
    ),
    tqApiUrl: requireString(env, 'TQ_API_URL'),
    tqWebUrl: optionalString(env, 'TQ_WEB_URL', 'https://tq.fohte.net'),
    port: optionalInt(env, 'PORT', 8080, { min: 1, max: 65_535 }),
    octoStsUrl: requireString(env, 'OCTO_STS_URL'),
    octoStsScope: requireString(env, 'OCTO_STS_SCOPE'),
    octoStsIdentity: requireString(env, 'OCTO_STS_IDENTITY'),
    octoStsSaTokenPath: optionalString(
      env,
      'OCTO_STS_SA_TOKEN_PATH',
      '/var/run/secrets/tokens/octo-sts-token',
    ),
  }).map((f) => ({
    githubWebhookSecret: f.githubWebhookSecret,
    sentryWebhookSecret: f.sentryWebhookSecret,
    grafanaWebhookSecret: f.grafanaWebhookSecret,
    grafanaApiToken: f.grafanaApiToken,
    slackBotToken: f.slackBotToken,
    slackChannel: f.slackChannel,
    slackActivityChannel: f.slackActivityChannel,
    tqApiUrl: f.tqApiUrl,
    tqWebUrl: f.tqWebUrl,
    port: f.port,
    octoSts: {
      url: f.octoStsUrl,
      scope: f.octoStsScope,
      identity: f.octoStsIdentity,
      saTokenPath: f.octoStsSaTokenPath,
    },
  }))
