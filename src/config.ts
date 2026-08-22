import {
  type EnvSource,
  type EnvValidationError,
  optionalInt,
  optionalString,
  parseEnv,
  requireString,
} from '@fohte/service-kit/env'
import type { Result } from 'neverthrow'

import type { OctoStsConfig } from '#auth/octo-sts'

export interface Config {
  githubWebhookSecret: string
  sentryWebhookSecret: string
  slackBotToken: string
  slackChannel: string
  slackActivityChannel: string
  port: number
  octoSts: OctoStsConfig
}

export const loadConfig = (
  env: EnvSource = process.env,
): Result<Config, EnvValidationError> =>
  parseEnv({
    githubWebhookSecret: requireString(env, 'GITHUB_WEBHOOK_SECRET'),
    sentryWebhookSecret: requireString(env, 'SENTRY_WEBHOOK_SECRET'),
    slackBotToken: requireString(env, 'SLACK_BOT_TOKEN'),
    slackChannel: optionalString(env, 'SLACK_CHANNEL', '#infra_alert'),
    slackActivityChannel: optionalString(
      env,
      'SLACK_ACTIVITY_CHANNEL',
      '#activity',
    ),
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
    slackBotToken: f.slackBotToken,
    slackChannel: f.slackChannel,
    slackActivityChannel: f.slackActivityChannel,
    port: f.port,
    octoSts: {
      url: f.octoStsUrl,
      scope: f.octoStsScope,
      identity: f.octoStsIdentity,
      saTokenPath: f.octoStsSaTokenPath,
    },
  }))
