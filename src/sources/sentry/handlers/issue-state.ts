const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeIssueId = (value: unknown): string | null => {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export const readSentryIssueId = (payload: unknown): string | null => {
  if (!isRecord(payload) || !isRecord(payload['data'])) return null

  const data = payload['data']
  const issue = data['issue']
  const issueId = isRecord(issue) ? normalizeIssueId(issue['id']) : null
  if (issueId !== null) return issueId

  const event = data['event']
  if (!isRecord(event)) return null
  return normalizeIssueId(event['group_id'])
}

export interface SentryIssueStateChange {
  issueId: string
  resolved: boolean
}

export const extractIssueStateChange = (
  payload: unknown,
): SentryIssueStateChange | null => {
  if (!isRecord(payload)) return null
  const action = payload['action']
  if (action !== 'resolved' && action !== 'unresolved') return null

  const issueId = readSentryIssueId(payload)
  return issueId === null ? null : { issueId, resolved: action === 'resolved' }
}
