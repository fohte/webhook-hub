// `sender.type === 'Bot'` covers every GitHub App sender (Renovate, Dependabot,
// etc.), so no bot-name allowlist is needed.
export const isThirdParty = (payload: {
  sender: { type: string; login: string }
  repository: { owner: { login: string } }
}): boolean =>
  payload.sender.type !== 'Bot' &&
  payload.sender.login !== payload.repository.owner.login
