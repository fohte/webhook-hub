import { gunzipSync, gzipSync } from 'node:zlib'

import { err, ok, Result } from 'neverthrow'

import {
  isRecord,
  isSlackBlock,
  type SlackBlock,
  type SlackMessageMetadata,
} from '#slack'

export const TQ_ORIGINAL_CONTENT_KEY = 'tq_original_content_v1'
// The metadata limit is unpublished, so this is a conservative local cap.
export const MAX_SLACK_METADATA_BYTES = 4_000

export interface TqOriginalContent {
  text: string
  color?: string
  blocks?: SlackBlock[]
}

export const encodeOriginalContent = (content: TqOriginalContent): string =>
  gzipSync(
    Buffer.from(
      JSON.stringify({
        text: content.text,
        color: content.color ?? null,
        blocks: content.blocks ?? null,
      }),
    ),
  ).toString('base64')

export const isWithinSlackMetadataSizeLimit = (
  metadata: SlackMessageMetadata,
): boolean =>
  Buffer.byteLength(JSON.stringify(metadata), 'utf8') <=
  MAX_SLACK_METADATA_BYTES

export const decodeOriginalContent = (
  value: unknown,
): TqOriginalContent | null => {
  if (typeof value !== 'string') return null

  const parsed = Result.fromThrowable(
    (): unknown =>
      JSON.parse(
        gunzipSync(Buffer.from(value, 'base64')).toString('utf8'),
      ) as unknown,
    (cause) => cause,
  )()

  return parsed
    .andThen((candidate) => {
      if (
        !isRecord(candidate) ||
        typeof candidate['text'] !== 'string' ||
        (candidate['color'] !== undefined &&
          candidate['color'] !== null &&
          typeof candidate['color'] !== 'string') ||
        (candidate['blocks'] !== undefined &&
          candidate['blocks'] !== null &&
          (!Array.isArray(candidate['blocks']) ||
            !candidate['blocks'].every(isSlackBlock)))
      ) {
        return err('invalid original Slack content')
      }

      const blocks = candidate['blocks']
      return ok({
        text: candidate['text'],
        ...(typeof candidate['color'] === 'string'
          ? { color: candidate['color'] }
          : {}),
        ...(Array.isArray(blocks)
          ? { blocks: blocks.filter(isSlackBlock) }
          : {}),
      })
    })
    .match(
      (content) => content,
      () => null,
    )
}
