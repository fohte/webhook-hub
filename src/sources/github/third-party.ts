import { escapeSlackMrkdwn } from '#slack-mrkdwn'

// `sender.type === 'Bot'` covers every GitHub App sender (Renovate, Dependabot, etc.).
export const isThirdParty = (payload: {
  sender: { type: string; login: string }
  repository: { owner: { login: string } }
}): boolean =>
  payload.sender.type !== 'Bot' &&
  payload.sender.login !== payload.repository.owner.login

export interface ThirdPartyActivityInput {
  repo: string
  title: string
  url: string
  author: string
}

export interface ThirdPartyActivityNotification {
  text: string
  repo: string
  url: string
}

export const buildThirdPartyActivityNotification = (
  kind: 'issue' | 'pull request',
  input: ThirdPartyActivityInput,
): ThirdPartyActivityNotification => ({
  text: [
    `:speech_balloon: *New ${kind} opened on \`${escapeSlackMrkdwn(input.repo)}\` by \`${escapeSlackMrkdwn(input.author)}\`*`,
    `*${escapeSlackMrkdwn(input.title)}*`,
    `<${input.url}|View ${kind}>`,
  ].join('\n'),
  repo: input.repo,
  url: input.url,
})
