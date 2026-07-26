import type { ResultAsync } from 'neverthrow'

import type { SlackApiError, SlackNotifier } from '#slack'

export type DispatchOutcome = 'notified' | 'filtered' | 'ignored'

export interface WebhookHeaders {
  get(name: string): string | null
}

export interface SourceContext {
  deliveryId: string
  eventName: string
}

export interface WebhookSource {
  readonly name: string
  readonly path: string
  /** A null result short-circuits `verify`/`dispatch` for this request. */
  extractContext(headers: WebhookHeaders): SourceContext | null
  verify(
    rawBody: string,
    headers: WebhookHeaders,
    context: SourceContext,
  ): Promise<boolean> | boolean
  dispatch(
    context: SourceContext,
    payload: unknown,
    notifier: SlackNotifier,
  ): ResultAsync<DispatchOutcome, SlackApiError>
}

/** Paths across sources must be unique; this is a precondition, not validated here. */
export type WebhookSourceRegistry = readonly WebhookSource[]

export type WebhookSourceRunResult =
  | { status: 'unrecognized' }
  | { status: 'unauthorized' }
  | { status: 'dispatched'; context: SourceContext; outcome: DispatchOutcome }
  | { status: 'error'; context: SourceContext; error: SlackApiError }

export const runWebhookSource = async (
  source: WebhookSource,
  rawBody: string,
  headers: WebhookHeaders,
  payload: unknown,
  notifier: SlackNotifier,
): Promise<WebhookSourceRunResult> => {
  const context = source.extractContext(headers)
  if (context === null) return { status: 'unrecognized' }

  const verified = await source.verify(rawBody, headers, context)
  if (!verified) return { status: 'unauthorized' }

  return source.dispatch(context, payload, notifier).match(
    (outcome) => ({ status: 'dispatched', context, outcome }),
    (error) => ({ status: 'error', context, error }),
  )
}
