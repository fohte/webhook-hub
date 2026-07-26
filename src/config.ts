export interface Config {
  githubWebhookSecret: string
  sentryWebhookSecret: string
  slackBotToken: string
  slackChannel: string
  port: number
}

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    // eslint-disable-next-line no-restricted-syntax -- process bootstrap must fail fast when required config is missing, before any Result-returning caller exists
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const loadConfig = (): Config => {
  const portRaw = process.env['PORT']
  const port = portRaw === undefined || portRaw === '' ? 8080 : Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) {
    // eslint-disable-next-line no-restricted-syntax -- process bootstrap must fail fast when required config is missing, before any Result-returning caller exists
    throw new Error(`Invalid PORT value: ${String(portRaw)}`)
  }

  return {
    githubWebhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    sentryWebhookSecret: required('SENTRY_WEBHOOK_SECRET'),
    slackBotToken: required('SLACK_BOT_TOKEN'),
    slackChannel: process.env['SLACK_CHANNEL'] ?? '#infra_alert',
    port,
  }
}
