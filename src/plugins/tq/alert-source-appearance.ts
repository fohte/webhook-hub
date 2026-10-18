import { logger } from '#logger'
import {
  decodeOriginalContent,
  encodeOriginalContent,
  isWithinSlackMetadataSizeLimit,
  replacePrimaryContent,
  TQ_ORIGINAL_CONTENT_KEY,
  type TqOriginalContent,
  withoutOriginalContentSnapshot,
} from '#plugins/tq/alert-task-snapshot'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'

const RESOLVED_SOURCE_COLOR = '#2eb67d'

const toOriginalContent = (
  content: SlackMessageContent,
): TqOriginalContent => ({
  text: content.text,
  ...(content.color === undefined ? {} : { color: content.color }),
  ...(content.blocks === undefined ? {} : { blocks: content.blocks }),
})

const readTitle = (content: TqOriginalContent): string => {
  const heading = content.blocks?.find((block) => block.type === 'header')
  return heading?.type === 'header'
    ? heading.text.text
    : (content.text.split('\n')[0] ?? '')
}

const readLinkBlocks = (blocks: SlackBlock[]): SlackBlock[] =>
  blocks.filter(
    (block) =>
      block.type === 'context' &&
      block.elements.some(
        (element) =>
          element.type === 'mrkdwn' && /<https?:\/\/[^>]+>/u.test(element.text),
      ),
  )

const makeResolvedAppearance = (
  content: TqOriginalContent,
): TqOriginalContent => {
  const rawTitle = readTitle(content)
  const title = escapeSlackMrkdwn(
    // Underscores inside :emoji: shortcodes are part of the shortcode name.
    rawTitle
      .split(/(:[a-z0-9_+-]+:)/giu)
      .map((part, index) =>
        index % 2 === 0
          ? part
              .replace(/~/g, '∼')
              .replace(/\*/g, '∗')
              .replace(/_/g, '＿')
              .replace(/`/g, 'ˋ')
          : part,
      )
      .join(''),
  )
  const heading = `*~${title}~*`
  const linkBlocks = readLinkBlocks(content.blocks ?? [])
  const linkText = linkBlocks.flatMap((block) =>
    block.type === 'context'
      ? block.elements
          .filter((element) => element.type === 'mrkdwn')
          .map((element) => element.text)
      : [],
  )
  return {
    text: [heading, ...linkText].join('\n'),
    color: RESOLVED_SOURCE_COLOR,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: heading } },
      ...linkBlocks,
    ],
  }
}

export const setSourceAlertResolved = (
  content: SlackMessageContent,
  resolved: boolean,
): SlackMessageContent => {
  const metadata = content.metadata
  if (metadata === undefined) return content

  const storedSnapshot = metadata.event_payload[TQ_ORIGINAL_CONTENT_KEY]
  if (!resolved) {
    if (storedSnapshot === undefined) return content
    const original = decodeOriginalContent(storedSnapshot)
    if (original === null) {
      logger.warn(
        { task_id: metadata.event_payload['task_id'] },
        'tq_original_content_decode_failed',
      )
      return content
    }

    return {
      ...replacePrimaryContent(content, original),
      metadata: {
        ...metadata,
        event_payload: withoutOriginalContentSnapshot(metadata.event_payload),
      },
    }
  }

  const original =
    storedSnapshot === undefined
      ? toOriginalContent(content)
      : decodeOriginalContent(storedSnapshot)
  if (original === null) {
    logger.warn(
      { task_id: metadata.event_payload['task_id'] },
      'tq_original_content_decode_failed',
    )
    return content
  }

  const snapshot =
    typeof storedSnapshot === 'string'
      ? storedSnapshot
      : encodeOriginalContent(original)
  const updatedMetadata = {
    ...metadata,
    event_payload: {
      ...metadata.event_payload,
      [TQ_ORIGINAL_CONTENT_KEY]: snapshot,
    },
  }
  if (!isWithinSlackMetadataSizeLimit(updatedMetadata)) {
    logger.warn(
      {
        task_id: metadata.event_payload['task_id'],
        metadata_bytes: Buffer.byteLength(
          JSON.stringify(updatedMetadata),
          'utf8',
        ),
      },
      'tq_original_content_snapshot_too_large',
    )
    return content
  }

  return {
    ...replacePrimaryContent(content, makeResolvedAppearance(original)),
    metadata: updatedMetadata,
  }
}
