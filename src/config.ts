import {
  type EnvSource,
  type EnvValidationError,
  optionalInt,
  optionalString,
  parseEnv,
  requireString,
} from '@fohte/service-kit/env'
import type { Result } from 'neverthrow'

export interface Config {
  githubWebhookSecret: string
  sentryWebhookSecret: string
  slackBotToken: string
  slackChannel: string
  slackActivityChannel: string
  port: number
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
      '#github_activity',
    ),
    port: optionalInt(env, 'PORT', 8080, { min: 1, max: 65_535 }),
  })
