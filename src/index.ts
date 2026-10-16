// Must stay the first import statement in this file: #bootstrap needs to run
// before any instrumented module is imported, or @opentelemetry/auto-instrumentations-node
// cannot patch them.
// eslint-disable-next-line simple-import-sort/imports -- must stay first, see comment above
import { observability } from '#bootstrap'

import { createOctoStsTokenCache } from '@fohte/service-kit/octo-sts'
import {
  createShutdownHandler,
  type ShutdownStep,
} from '@fohte/service-kit/shutdown'
import { serve } from '@hono/node-server'

import { loadConfig } from '#config'
import { createGitHubClient } from '#github-client'
import { logger } from '#logger'
import { createTqClient } from '#plugins/tq/tq-client'
import { createApp } from '#server'
import { createSlackNotifier } from '#slack'
import { checkSlackScopesAtStartup } from '#slack-startup'
import { createGithubSource } from '#sources/github/index'
import { createGrafanaSource } from '#sources/grafana/index'
import { createGrafanaPanelImageRenderer } from '#sources/grafana/panel-image'
import { createSentrySource } from '#sources/sentry/index'
import { createTqStatusSource } from '#sources/tq-status/index'

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
  void checkSlackScopesAtStartup(notifier)
  const panelImageRenderer =
    config.grafanaApiToken === ''
      ? undefined
      : createGrafanaPanelImageRenderer(
          config.grafanaApiToken,
          config.grafanaUrl,
        )
  if (panelImageRenderer === undefined) {
    logger.warn({}, 'grafana_panel_images_disabled')
  }
  const octoStsTokenCache = createOctoStsTokenCache(config.octoSts)
  const githubClient = createGitHubClient(octoStsTokenCache)
  const tqClient = createTqClient(config.tqApiUrl)
  const app = createApp({
    sources: [
      createGithubSource(
        config.githubWebhookSecret,
        config.slackActivityChannel,
        githubClient,
        tqClient,
        config.tqWebUrl,
      ),
      createSentrySource(config.sentryWebhookSecret, tqClient, config.tqWebUrl),
      createGrafanaSource(
        config.grafanaWebhookSecret,
        tqClient,
        config.tqWebUrl,
        panelImageRenderer,
      ),
      createTqStatusSource(config.tqWebhookSecret, config.tqWebUrl),
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
    {
      name: 'drain-webhook-dispatches',
      run: () => app.drainBackgroundDispatches(),
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
