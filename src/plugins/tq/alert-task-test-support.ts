import { gunzipSync } from 'node:zlib'

import { Result } from 'neverthrow'

import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task'
import type { SlackMessageContent } from '#slack'

export type DecodedSlackMessageContent = Omit<
  SlackMessageContent,
  'metadata'
> & {
  metadata?: {
    event_type: string
    event_payload: Record<string, unknown>
  }
}

export const expectedTqOriginalContentSnapshot = (
  content: SlackMessageContent,
) => ({
  text: content.text,
  color: content.color ?? null,
  blocks: content.blocks ?? null,
})

export const normalizeTqOriginalContentSnapshot = (
  content: SlackMessageContent,
): DecodedSlackMessageContent => {
  const metadata = content.metadata
  if (metadata === undefined) return content
  const snapshot = metadata.event_payload[TQ_ORIGINAL_CONTENT_KEY]
  if (typeof snapshot !== 'string') return content

  const decoded = Result.fromThrowable(
    (): unknown =>
      JSON.parse(gunzipSync(Buffer.from(snapshot, 'base64')).toString('utf8')),
    () => snapshot,
  )().match(
    (value) => value,
    (value) => value,
  )
  return {
    ...content,
    metadata: {
      ...metadata,
      event_payload: {
        ...metadata.event_payload,
        [TQ_ORIGINAL_CONTENT_KEY]: decoded,
      },
    },
  }
}
