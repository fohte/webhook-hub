# webhook-hub

@fohte's personal hub that receives webhooks (GitHub, Sentry, Grafana, tq) and forwards a curated subset to a configurable Slack channel.

[![Test](https://github.com/fohte/webhook-hub/actions/workflows/test.yml/badge.svg)](https://github.com/fohte/webhook-hub/actions/workflows/test.yml)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-fohte%2Fwebhook--hub-blue?logo=github)](https://github.com/fohte/webhook-hub/pkgs/container/webhook-hub)

## Features

Only the following events are forwarded to Slack; everything else is acknowledged with `200` and dropped.

- **CI failures on the default branch** — `workflow_run` events where `action=completed`, `conclusion=failure`, and the head branch matches the repository's default branch. Fork-originated runs are excluded. The notification is a Block Kit message with the failing job/step and, when available, a link to the PR that introduced the change.
- **Renovate security PRs** — `pull_request` events where either the title ends with `[security]` or the head branch matches `renovate/*-vulnerability`. The original `opened` notification is edited in place on `closed`: green border while open, purple when merged, red when closed without merging.
- **Sentry issue alerts** — Sentry `event_alert` webhooks where `action=triggered`.
- **Grafana alerts** — each firing or resolved alert is posted separately. Redeliveries with the same fingerprint and `startsAt` update the existing Slack message without creating another tq task; a later incident with the same fingerprint gets its own message and task.
- **tq task status changes** — `task.status_changed` webhooks update the lower Slack attachment to `todo`, `completed`, `not planned`, or `duplicate of #N <title>` while preserving the source alert above it. The lookup searches the most recent 1,000 Slack channel messages.

CI, Sentry, and Grafana alert notifications include a `todo` status and a [tq task](https://github.com/fohte/tq) link in the lower attachment when task creation succeeds. Task creation is best-effort: if the tq API is unavailable, the Slack notification still posts without a task link.

## Endpoints

| Method | Path       | Description                                                                                                                                                             |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/github`  | GitHub webhook receiver. Verifies `x-hub-signature-256`; rejects invalid signatures with `401`. Handler errors return `200` to suppress GitHub's redelivery.            |
| `POST` | `/sentry`  | Sentry webhook receiver. Verifies `Sentry-Hook-Signature`; rejects invalid signatures with `401`. Handler errors return `200` to suppress Sentry's redelivery.          |
| `POST` | `/grafana` | Grafana webhook receiver. Verifies `X-Grafana-Alerting-Signature`; rejects invalid signatures with `401`. Handler errors return `200` to suppress Grafana's redelivery. |
| `POST` | `/tq`      | tq status webhook receiver. Verifies `X-Tq-Signature-256`; rejects invalid signatures with `401`. Handler errors return `200` to suppress tq's redelivery.              |
| `GET`  | `/healthz` | Liveness probe; returns `ok`.                                                                                                                                           |

## Configuration

| Variable                 | Required | Default                                  | Description                                                                                                   |
| ------------------------ | -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | —                                        | Shared secret for HMAC signature verification.                                                                |
| `SENTRY_WEBHOOK_SECRET`  | Yes      | —                                        | Shared secret for `Sentry-Hook-Signature` verification.                                                       |
| `GRAFANA_WEBHOOK_SECRET` | Yes      | —                                        | Shared secret for `X-Grafana-Alerting-Signature` verification.                                                |
| `TQ_WEBHOOK_SECRET`      | Yes      | —                                        | Shared secret for `X-Tq-Signature-256` verification.                                                          |
| `GRAFANA_URL`            | No       | `https://fohte.grafana.net`              | Grafana base URL used to render panel images.                                                                 |
| `GRAFANA_API_TOKEN`      | No       | —                                        | Grafana service account token with dashboard read access; enables panel images on Grafana alerts.             |
| `SLACK_BOT_TOKEN`        | Yes      | —                                        | Slack bot token. Required scopes are listed in the Setup section.                                             |
| `SLACK_CHANNEL`          | No       | `#infra_alert`                           | Slack channel ID or name to post to.                                                                          |
| `SLACK_ACTIVITY_CHANNEL` | No       | `#activity`                              | Slack channel ID or name reserved for upcoming GitHub activity notifications; not sent to by any handler yet. |
| `TQ_API_URL`             | Yes      | —                                        | tq API base URL used to create tasks for CI, Sentry, and Grafana alerts.                                      |
| `TQ_WEB_URL`             | No       | `https://tq.fohte.net`                   | tq web app base URL used to link created tasks in Slack.                                                      |
| `PORT`                   | No       | `8080`                                   | HTTP listen port.                                                                                             |
| `OCTO_STS_URL`           | Yes      | —                                        | octo-sts endpoint used to exchange an OIDC token for a short-lived GitHub App token.                          |
| `OCTO_STS_SCOPE`         | Yes      | —                                        | GitHub org octo-sts issues the token for (owner-only, not `owner/repo`).                                      |
| `OCTO_STS_IDENTITY`      | Yes      | —                                        | octo-sts trust policy identity to assume.                                                                     |
| `OCTO_STS_SA_TOKEN_PATH` | No       | `/var/run/secrets/tokens/octo-sts-token` | Path to the projected Kubernetes ServiceAccount token used as the OIDC token.                                 |

## Setup

To run the service against real deliveries, these things need to be wired up.

1. **Run the container.** The published image listens on `8080`:

   ```bash
   docker run --rm -p 8080:8080 \
     -e GITHUB_WEBHOOK_SECRET=... \
     -e SENTRY_WEBHOOK_SECRET=... \
     -e GRAFANA_WEBHOOK_SECRET=... \
     -e TQ_WEBHOOK_SECRET=... \
     -e GRAFANA_API_TOKEN=... \
     -e SLACK_BOT_TOKEN=xoxb-... \
     -e SLACK_CHANNEL=#your-channel \
     -e TQ_API_URL=http://tq-api.example.test:3001 \
     -e TQ_WEB_URL=https://tq.example.test \
     ghcr.io/fohte/webhook-hub:latest
   ```

   Expose the container behind HTTPS at a URL the webhook sources can reach.

   Set `TQ_API_URL` to a tq API endpoint reachable from the container. webhook-hub sends `POST <TQ_API_URL>/api/tasks` without an authentication header. Set `TQ_WEB_URL` when the task links should use a different web app host.

2. **Register the webhook on each source repository** (Settings → Webhooks):
   - Payload URL: `https://<your-host>/github`
   - Content type: `application/json`
   - Secret: same value as `GITHUB_WEBHOOK_SECRET`
   - Events: `Workflow runs` and `Pull requests` (or `Send me everything` — non-matching events are ignored)

3. **Register the webhook in Sentry** (Settings → Developer Settings → Internal Integrations), enabling the `Issue` webhook resource and an `Issue Alert` action:
   - Webhook URL: `https://<your-host>/sentry`
   - Secret: same value as `SENTRY_WEBHOOK_SECRET`

   Creating the integration alone does not send anything — add an action to each project's Alert Rules that notifies this integration.

4. **Register a Grafana webhook contact point**:
   - URL: `https://<your-host>/grafana`
   - Enable HMAC signature and use the same value as `GRAFANA_WEBHOOK_SECRET`
   - Keep the signature header as `X-Grafana-Alerting-Signature`
   - Leave the optional timestamp header unset
   - To include panel images, set `GRAFANA_API_TOKEN` to a service account token with dashboard read access. Set `GRAFANA_URL` if the alerts come from a different Grafana instance than the default. Link each alert rule to its dashboard panel, and make sure the instance provides the `/render/d-solo` image rendering API.

5. **Register a webhook in tq for task status changes**:
   - Webhook URL: `https://<your-host>/tq`
   - Secret: same value as `TQ_WEBHOOK_SECRET`
   - Subscribe to `task.status_changed`

6. **Provision octo-sts.** The CI-failure notification calls the GitHub REST API (PR lookup, failed job/step) via [octo-sts](https://github.com/octo-sts/app) rather than a PAT, using a projected Kubernetes ServiceAccount token as the OIDC credential. This requires an octo-sts trust policy that grants the deploying identity read-only `pull_requests` and `actions` permissions, and a Kubernetes ServiceAccount token projected into the container at the path configured by `OCTO_STS_SA_TOKEN_PATH`. The `OCTO_STS_*` variables above point the service at the octo-sts endpoint and the trust policy identity/scope to assume.

7. **Create the Slack bot.** Grant the following scopes, install it to the workspace, and invite it into the target channel. Use the bot token (`xoxb-...`) for `SLACK_BOT_TOKEN`.
   - `chat:write` — post and edit messages
   - `chat:write.customize` — post CI-failure notifications under a custom username/icon
   - `channels:history` and `channels:read` (public channel) or `groups:history` and `groups:read` (private channel) — look up messages and resolve the channel name
   - `metadata.message:read` — read embedded alert fingerprints, task references, and PR identifiers on history items
   - `files:write` — upload Grafana panel images

   Adding a scope to an existing app requires reinstalling it to the workspace.

## Development

Prerequisites: Node.js 24 (managed via [mise](https://mise.jdx.dev/)), pnpm 11.

```bash
pnpm install
pnpm dev
pnpm test   # type-check + vitest
pnpm build  # emit dist/
pnpm start
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the request flow and notification rules.
