// Slack requires &, <, > to be escaped in mrkdwn to avoid breaking link / entity syntax.
// https://api.slack.com/reference/surfaces/formatting#escaping
export const escapeSlackMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Attachment `fallback` must be plain text and "should not contain any markup":
// https://docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments/
export const toSlackFallbackText = (s: string): string =>
  s.replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/[*_~`]/g, '')
