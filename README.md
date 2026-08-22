# webhook-hub

@fohte's personal hub that receives webhooks (GitHub, Sentry) and forwards a curated subset to a configurable Slack channel.

[![Test](https://github.com/fohte/webhook-hub/actions/workflows/test.yml/badge.svg)](https://github.com/fohte/webhook-hub/actions/workflows/test.yml)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-fohte%2Fwebhook--hub-blue?logo=github)](https://github.com/fohte/webhook-hub/pkgs/container/webhook-hub)

## Features

Only the following events are forwarded to Slack; everything else is acknowledged with `200` and dropped.

- **CI failures on the default branch** — `workflow_run` events where `action=completed`, `conclusion=failure`, and the head branch matches the repository's default branch. Fork-originated runs are excluded.
- **Renovate security PRs** — `pull_request` events where either the title ends with `[security]` or the head branch matches `renovate/*-vulnerability`. The original `opened` notification is edited in place on `closed`: green border while open, purple when merged, red when closed without merging.
- **Sentry issue alerts** — Sentry `event_alert` webhooks where `action=triggered`.

## Endpoints

| Method | Path       | Description                                                                                                                                                    |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/github`  | GitHub webhook receiver. Verifies `x-hub-signature-256`; rejects invalid signatures with `401`. Handler errors return `200` to suppress GitHub's redelivery.   |
| `POST` | `/sentry`  | Sentry webhook receiver. Verifies `Sentry-Hook-Signature`; rejects invalid signatures with `401`. Handler errors return `200` to suppress Sentry's redelivery. |
| `GET`  | `/healthz` | Liveness probe; returns `ok`.                                                                                                                                  |

## Configuration

| Variable                 | Required | Default            | Description                                                                                                   |
| ------------------------ | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | —                  | Shared secret for HMAC signature verification.                                                                |
| `SENTRY_WEBHOOK_SECRET`  | Yes      | —                  | Shared secret for `Sentry-Hook-Signature` verification.                                                       |
| `SLACK_BOT_TOKEN`        | Yes      | —                  | Slack bot token. Required scopes are listed in the Setup section.                                             |
| `SLACK_CHANNEL`          | No       | `#infra_alert`     | Slack channel ID or name to post to.                                                                          |
| `SLACK_ACTIVITY_CHANNEL` | No       | `#github_activity` | Slack channel ID or name reserved for upcoming GitHub activity notifications; not sent to by any handler yet. |
| `PORT`                   | No       | `8080`             | HTTP listen port.                                                                                             |

## Setup

To run the service against real deliveries, these things need to be wired up.

1. **Run the container.** The published image listens on `8080`:

   ```bash
   docker run --rm -p 8080:8080 \
     -e GITHUB_WEBHOOK_SECRET=... \
     -e SENTRY_WEBHOOK_SECRET=... \
     -e SLACK_BOT_TOKEN=xoxb-... \
     -e SLACK_CHANNEL=#your-channel \
     ghcr.io/fohte/webhook-hub:latest
   ```

   Expose the container behind HTTPS at a URL the webhook sources can reach.

2. **Register the webhook on each source repository** (Settings → Webhooks):
   - Payload URL: `https://<your-host>/github`
   - Content type: `application/json`
   - Secret: same value as `GITHUB_WEBHOOK_SECRET`
   - Events: `Workflow runs` and `Pull requests` (or `Send me everything` — non-matching events are ignored)

3. **Register the webhook in Sentry** (Settings → Developer Settings → Internal Integrations), enabling the `Issue` webhook resource and an `Issue Alert` action:
   - Webhook URL: `https://<your-host>/sentry`
   - Secret: same value as `SENTRY_WEBHOOK_SECRET`

   Creating the integration alone does not send anything — add an action to each project's Alert Rules that notifies this integration.

4. **Create the Slack bot.** Grant the following scopes, install it to the workspace, and invite it into the target channel. Use the bot token (`xoxb-...`) for `SLACK_BOT_TOKEN`.
   - `chat:write` — post and edit messages
   - `channels:history` (public channel) or `groups:history` (private channel) — look up the original PR message to edit on close
   - `metadata.message:read` — read the embedded PR identifier on history items
   - `channels:read` and/or `groups:read` — resolve `SLACK_CHANNEL` name (`#foo`) to a channel ID

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
