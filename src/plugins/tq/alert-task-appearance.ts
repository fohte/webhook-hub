import type { TqTaskStatusInfo } from '#plugins/tq/alert-task'
import type { TqOriginalContent } from '#plugins/tq/alert-task-snapshot'
import type {
  SlackBlock,
  SlackMessageContent,
  SlackMessageMetadata,
} from '#slack'
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
  header.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')

const formatPrimaryContext = (
  content: TqOriginalContent,
  metadata?: SlackMessageMetadata,
): string => {
  const blocks = content.blocks ?? []
  const fields = readFields(blocks)
  const repository = fields.get(ALERT_FIELD_LABELS.repository)
  const origin = fields.get(ALERT_FIELD_LABELS.originPullRequest)
  if (repository !== undefined && origin !== undefined) {
    return `${repository} · ${ALERT_FIELD_LABELS.originPullRequest} ${origin}`
  }

  if (readGrafanaStatus(metadata, content) !== undefined) {
    const grafanaFields = [...fields.entries()]
      .filter(([label]) => label !== ALERT_FIELD_LABELS.grafanaLegacyStatus)
      .slice(0, 2)
    if (grafanaFields.length > 0) {
      return grafanaFields
        .map(([label, value]) => `${label}: ${value}`)
        .join(' · ')
    }
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
  metadata?: SlackMessageMetadata,
): SlackMessageContent => {
  const icon =
    info.statusReason === 'not_planned'
      ? '⏭️'
      : info.statusReason === 'duplicate'
        ? '🔁'
        : '✅'
  const title = escapeSlackMrkdwn(
    stripLeadingIcon(readHeader(content))
      .replace(/~/g, '∼')
      .replace(/\*/g, '∗')
      .replace(/_/g, '＿')
      .replace(/`/g, 'ˋ'),
  )
  const heading = `*${icon} ~${title}~*`
  const context = formatPrimaryContext(content, metadata)

  return {
    text: `${heading}\n${context}\n${status}`,
    color:
      info.statusReason === 'completed' || info.statusReason === null
        ? COMPLETED_COLOR
        : DISMISSED_COLOR,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: heading } },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: context },
          { type: 'mrkdwn', text: status },
        ],
      },
    ],
  }
}

export const isCompactedAppearance = (content: SlackMessageContent): boolean =>
  content.blocks?.[0]?.type === 'section' &&
  content.blocks[0].text?.type === 'mrkdwn' &&
  /^\*(?:✅|⏭️|🔁) ~/u.test(content.blocks[0].text.text)

export const readGrafanaStatus = (
  metadata: SlackMessageMetadata | undefined,
  content?: TqOriginalContent,
): 'firing' | 'resolved' | undefined => {
  const status = metadata?.event_payload['grafana_status']
  if (status === 'firing' || status === 'resolved') return status
  if (metadata?.event_type !== 'grafana_alert' || content === undefined) {
    return undefined
  }

  const legacyStatus = readFields(content.blocks ?? []).get(
    ALERT_FIELD_LABELS.grafanaLegacyStatus,
  )
  return legacyStatus === '発生中'
    ? 'firing'
    : legacyStatus === '解決'
      ? 'resolved'
      : undefined
}
