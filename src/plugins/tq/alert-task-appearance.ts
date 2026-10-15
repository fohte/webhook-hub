import type { TqTaskStatusInfo } from '#plugins/tq/alert-task'
import type { TqOriginalContent } from '#plugins/tq/alert-task-snapshot'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'
import { ALERT_FIELD_LABELS } from '#sources/alert-field-labels'

const COMPLETED_COLOR = '#2da44e'
const DISMISSED_COLOR = '#8b949e'

const parseField = (text: string): [string, string] | null => {
  const newline = text.indexOf('\n')
  if (newline === -1) return null
  const label = text.slice(0, newline).replace(/^\*|\*$/g, '')
  return [label, text.slice(newline + 1)]
}

const readFields = (blocks: SlackBlock[]): Map<string, string> => {
  const fields = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'section' || block.fields === undefined) continue
    for (const field of block.fields) {
      if (field.type !== 'mrkdwn') continue
      const parsed = parseField(field.text)
      if (parsed !== null) fields.set(...parsed)
    }
  }
  return fields
}

const readContext = (blocks: SlackBlock[]): string | null => {
  const elements = blocks.flatMap((block) =>
    block.type === 'context'
      ? block.elements
          .filter(
            (element): element is { type: 'mrkdwn'; text: string } =>
              element.type === 'mrkdwn',
          )
          .map((element) => element.text)
      : [],
  )
  return elements.length === 0 ? null : elements.join(' · ')
}

const readHeader = (content: TqOriginalContent): string => {
  const header = content.blocks?.find((block) => block.type === 'header')
  return header?.type === 'header'
    ? header.text.text
    : (content.text.split('\n')[0] ?? '')
}

const stripLeadingIcon = (header: string): string =>
  header.replace(/^[^\p{L}\p{N}]+\s*/u, '')

const formatPrimaryContext = (content: TqOriginalContent): string => {
  const blocks = content.blocks ?? []
  const fields = readFields(blocks)
  const repository = fields.get(ALERT_FIELD_LABELS.repository)
  const origin = fields.get(ALERT_FIELD_LABELS.originPullRequest)
  if (repository !== undefined && origin !== undefined) {
    return `${repository} · ${ALERT_FIELD_LABELS.originPullRequest} ${origin}`
  }

  const grafanaStatus = fields.get(ALERT_FIELD_LABELS.grafanaStatus)
  if (grafanaStatus !== undefined) {
    return `${ALERT_FIELD_LABELS.grafanaStatus}: ${grafanaStatus}`
  }

  const app = fields.get(ALERT_FIELD_LABELS.sentryApp)
  const context = readContext(blocks)
  if (app !== undefined && context !== null) return `${app} · ${context}`
  if (context !== null) return context

  const firstField = blocks.find(
    (block) => block.type === 'section' && block.fields !== undefined,
  )
  if (
    firstField?.type === 'section' &&
    firstField.fields?.[0]?.type === 'mrkdwn'
  ) {
    const field = parseField(firstField.fields[0].text)
    if (field !== null) return `${field[0]}: ${field[1]}`
  }
  return stripLeadingIcon(readHeader(content))
}

export const compactAppearance = (
  content: TqOriginalContent,
  status: string,
  info: TqTaskStatusInfo,
): SlackMessageContent => {
  const icon =
    info.statusReason === 'not_planned'
      ? '⏭️'
      : info.statusReason === 'duplicate'
        ? '🔁'
        : '✅'
  const title = escapeSlackMrkdwn(
    stripLeadingIcon(readHeader(content)).replace(/~/g, '∼'),
  )
  const heading = `*${icon} ~${title}~*`
  const context = formatPrimaryContext(content)
  const summary = `${context}\n${status}`

  return {
    text: `${heading}\n${summary}`,
    color:
      info.statusReason === 'completed' || info.statusReason === null
        ? COMPLETED_COLOR
        : DISMISSED_COLOR,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: heading } },
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
    ],
  }
}
