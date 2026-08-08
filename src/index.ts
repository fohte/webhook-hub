// Must stay the first import statement in this file: #bootstrap needs to run
// before any instrumented module is imported, or @opentelemetry/auto-instrumentations-node
// cannot patch them.
// eslint-disable-next-line simple-import-sort/imports -- must stay first, see comment above
import { observability } from '#bootstrap'

import {
  createShutdownHandler,
  type ShutdownStep,
} from '@fohte/service-kit/shutdown'
import { serve } from '@hono/node-server'

import { loadConfig } from '#config'
import { logger } from '#logger'
import { createApp } from '#server'
import { createSlackNotifier } from '#slack'
import { createGithubSource } from '#sources/github/index'
import { createSentrySource } from '#sources/sentry/index'

const main = (): void => {
  const configResult = loadConfig()
  if (configResult.isErr()) {
    logger.error({ err: configResult.error }, 'invalid_config')
    process.exit(1)
  }
  const config = configResult.value

  const notifier = createSlackNotifier(
    config.slackBotToken,
    config.slackChannel,
  )
  const app = createApp({
    sources: [
      createGithubSource(config.githubWebhookSecret),
      createSentrySource(config.sentryWebhookSecret),
    ],
    notifier,
  })
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'server_listening')
  })

  const steps: ShutdownStep[] = [
    {
      name: 'close-server',
      // server.close() waits indefinitely for in-flight requests to finish;
      // force-close remaining connections after a bound so one hung request
      // (e.g. Slack API) can't stall shutdown forever.
      run: () =>
        new Promise<void>((resolve) => {
          const forceCloseTimer = setTimeout(() => {
            if ('closeAllConnections' in server) {
              server.closeAllConnections()
            }
          }, 5_000)
          server.close(() => {
            clearTimeout(forceCloseTimer)
            resolve()
          })
        }),
    },
  ]
  const observabilityHandle = observability
  if (observabilityHandle) {
    steps.push({
      name: 'observability',
      run: () => observabilityHandle.shutdown(),
    })
  }
  createShutdownHandler(steps, { logger })
}

main()
