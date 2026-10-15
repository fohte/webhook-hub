import { TQ_ORIGINAL_CONTENT_KEY } from '#plugins/tq/alert-task'
import type { SlackMessageContent } from '#slack'

export const normalizeTqOriginalContentSnapshot = (
  content: SlackMessageContent,
): SlackMessageContent => {
  const metadata = content.metadata
  if (metadata === undefined) return content
  const snapshot = metadata.event_payload[TQ_ORIGINAL_CONTENT_KEY]
  return typeof snapshot !== 'string'
    ? content
    : {
        ...content,
        metadata: {
          ...metadata,
          event_payload: {
            ...metadata.event_payload,
            [TQ_ORIGINAL_CONTENT_KEY]: '<compressed original content>',
          },
        },
      }
}
