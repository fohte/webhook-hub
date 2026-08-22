import { Webhooks } from '@octokit/webhooks'

import { dispatch } from '#sources/github/dispatch'
import type { WebhookSource } from '#webhook-source'

export const createGithubSource = (
  webhookSecret: string,
  activityChannel: string,
): WebhookSource => {
  const webhooks = new Webhooks({ secret: webhookSecret })
  return {
    name: 'github',
    path: '/github',
    extractContext: (headers) => {
      const deliveryId = headers.get('x-github-delivery')
      const eventName = headers.get('x-github-event')
      const signature = headers.get('x-hub-signature-256')
      if (deliveryId === null || eventName === null || signature === null) {
        return null
      }
      return { deliveryId, eventName }
    },
    verify: (rawBody, headers) =>
      // extractContext already rejected a missing signature header, so this
      // is never called with an empty string (@octokit/webhooks-methods
      // throws TypeError on a falsy signature).
      webhooks.verify(rawBody, headers.get('x-hub-signature-256') ?? ''),
    dispatch: (context, payload, notifier) =>
      dispatch(
        {
          deliveryId: context.deliveryId,
          event: context.eventName,
          notifier,
          activityChannel,
        },
        { name: context.eventName, payload },
      ),
  }
}
