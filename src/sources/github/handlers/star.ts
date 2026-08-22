import type { StarCreatedEvent } from '@octokit/webhooks-types'

import { escapeSlackMrkdwn } from '#slack-mrkdwn'

export interface StarInput {
  repo: string
  repoUrl: string
  sender: string
}

export interface StarNotification {
  text: string
  repo: string
  sender: string
}

export const extractStarInput = (payload: StarCreatedEvent): StarInput => ({
  repo: payload.repository.full_name,
  repoUrl: payload.repository.html_url,
  sender: payload.sender.login,
})

export const buildStarNotification = (input: StarInput): StarNotification => {
  const text = [
    `:star: *\`${escapeSlackMrkdwn(input.repo)}\` was starred by \`${escapeSlackMrkdwn(input.sender)}\`*`,
    `<${input.repoUrl}|View repository>`,
  ].join('\n')

  return { text, repo: input.repo, sender: input.sender }
}
