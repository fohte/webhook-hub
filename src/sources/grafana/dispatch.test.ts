import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { TqApiError, type TqClient } from '#plugins/tq/tq-client'
import { SlackApiError, type SlackNotifier } from '#slack'
import type { DispatchContext } from '#sources/grafana/dispatch'
import { dispatch } from '#sources/grafana/dispatch'
import { GrafanaPanelImageError } from '#sources/grafana/panel-image'
import type { DispatchOutcome } from '#webhook-source'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const TQ_TASK_REF = {
  id: '00000000-0000-4000-8000-000000000009',
  number: 9,
}
const TQ_WEB_URL = 'https://tasks.example.test'
const INCIDENT_START = '2026-01-01T00:00:00Z'
const ALERT = {
  status: 'firing',
  labels: { alertname: 'Queue depth' },
  annotations: { summary: 'Queue is growing' },
  fingerprint: 'fp-queue',
  startsAt: INCIDENT_START,
}

const createNotifier = () => {
  const postMessage = vi
    .fn<SlackNotifier['postMessage']>()
    .mockReturnValue(okAsync({ channel: 'C1', ts: '1' }))
  const updateMessage = vi
    .fn<SlackNotifier['updateMessage']>()
    .mockReturnValue(okAsync(undefined))
  const findMessageByMetadata = vi
    .fn<SlackNotifier['findMessageByMetadata']>()
    .mockReturnValue(okAsync(null))
  const uploadImage = vi
    .fn<SlackNotifier['uploadImage']>()
    .mockReturnValue(okAsync('FIMAGE'))
  return { postMessage, updateMessage, findMessageByMetadata, uploadImage }
}

const createTqClient = (
  result: ReturnType<TqClient['createTask']> = okAsync(TQ_TASK_REF),
) => ({
  createTask: vi.fn<TqClient['createTask']>().mockReturnValue(result),
})

const createContext = (
  notifier: DispatchContext['notifier'],
  tqClient = createTqClient(),
  panelImageRenderer?: DispatchContext['panelImageRenderer'],
): DispatchContext => ({
  deliveryId: 'grafana',
  eventName: 'alerting',
  notifier,
  ...(panelImageRenderer === undefined ? {} : { panelImageRenderer }),
  tqClient,
  tqWebUrl: TQ_WEB_URL,
})

const dispatchOutcome = async (
  ...args: Parameters<typeof dispatch>
): Promise<DispatchOutcome> => (await dispatch(...args))._unsafeUnwrap()

const matcherCalls = (
  calls: Parameters<SlackNotifier['findMessageByMetadata']>[],
  startsAt = '',
): unknown[][] =>
  calls.map(([eventType, matcher, options]) => [
    eventType,
    matcher({ fingerprint: 'fp-queue', starts_at: startsAt }),
    matcher({ fingerprint: 'fp-queue', starts_at: 'different-incident' }),
    matcher({ fingerprint: 'another-fingerprint', starts_at: startsAt }),
    options,
  ])

const observeDispatch = <TOutcome, TObservations>(
  outcome: TOutcome,
  observations: TObservations,
) => ({ outcome, ...observations })

const expectedAlertContent = (imageFileId?: string) => ({
  text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
  color: '#d73a49',
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: '🚨 Queue depth' } },
    {
      type: 'section',
      fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
        },
      ],
    },
    ...(imageFileId === undefined
      ? []
      : [
          {
            type: 'image' as const,
            slack_file: { id: imageFileId },
            alt_text: 'Grafana panel 13',
          },
        ]),
  ],
  metadata: {
    event_type: 'grafana_alert',
    event_payload: {
      fingerprint: 'fp-queue',
      starts_at: INCIDENT_START,
      task_id: '00000000-0000-4000-8000-000000000009',
      task_number: 9,
      ...(imageFileId === undefined
        ? {}
        : { panel_image_file_id: imageFileId }),
    },
  },
})

describe('dispatch', () => {
  it('creates one tq task and posts one notification for a new fingerprint', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [ALERT],
    })

    expect(
      observeDispatch(outcome, {
        matcherCalls: matcherCalls(
          notifier.findMessageByMetadata.mock.calls,
          INCIDENT_START,
        ),
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      matcherCalls: [
        [
          'grafana_alert',
          true,
          false,
          false,
          {
            oldest: '1767139200',
            latest: '1767312000',
            maxPages: 5,
          },
        ],
      ],
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              `Started at: ${INCIDENT_START}`,
              'Labels:\n- alertname: Queue depth',
              'Annotations:\n- summary: Queue is growing',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                starts_at: INCIDENT_START,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
      updateCalls: [],
    })
  })

  it('adds an uploaded panel image to the Slack alert blocks', async () => {
    const notifier = createNotifier()
    const imageBuffer = Buffer.from('png-data')
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(okAsync({ buffer: imageBuffer, panelId: '13' })),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, createTqClient(), panelImageRenderer),
      { alerts: [ALERT] },
    )

    expect(
      observeDispatch(outcome, {
        renderCalls: panelImageRenderer.render.mock.calls,
        uploadCalls: notifier.uploadImage.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      renderCalls: [[ALERT]],
      uploadCalls: [
        [
          {
            data: imageBuffer,
            filename: 'grafana-panel-13.png',
            altText: 'Grafana panel 13',
          },
        ],
      ],
      postCalls: [[expectedAlertContent('FIMAGE')]],
    })
  })

  it('posts the notification body when panel image rendering fails', async () => {
    const notifier = createNotifier()
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(errAsync(new GrafanaPanelImageError('render failed'))),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, createTqClient(), panelImageRenderer),
      { alerts: [ALERT] },
    )

    expect(
      observeDispatch(outcome, {
        renderCalls: panelImageRenderer.render.mock.calls,
        uploadCalls: notifier.uploadImage.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      renderCalls: [[ALERT]],
      uploadCalls: [],
      postCalls: [[expectedAlertContent()]],
    })
  })

  it('posts the notification body when Slack image upload fails', async () => {
    const notifier = createNotifier()
    notifier.uploadImage.mockReturnValue(
      errAsync(new SlackApiError('upload failed')),
    )
    const imageBuffer = Buffer.from('png-data')
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(okAsync({ buffer: imageBuffer, panelId: '13' })),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, createTqClient(), panelImageRenderer),
      { alerts: [ALERT] },
    )

    expect(
      observeDispatch(outcome, {
        uploadCalls: notifier.uploadImage.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      uploadCalls: [
        [
          {
            data: imageBuffer,
            filename: 'grafana-panel-13.png',
            altText: 'Grafana panel 13',
          },
        ],
      ],
      postCalls: [[expectedAlertContent()]],
    })
  })

  it('updates a repeated fingerprint without creating another task or message', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(
      okAsync({
        ref: { channel: 'C9', ts: 'existing-ts' },
        eventPayload: {
          fingerprint: 'fp-queue',
          starts_at: INCIDENT_START,
          task_id: TQ_TASK_REF.id,
          task_number: TQ_TASK_REF.number,
        },
      }),
    )
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [{ ...ALERT, status: 'resolved' }],
    })

    expect(
      observeDispatch(outcome, {
        matcherCalls: matcherCalls(
          notifier.findMessageByMetadata.mock.calls,
          INCIDENT_START,
        ),
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      matcherCalls: [
        [
          'grafana_alert',
          true,
          false,
          false,
          {
            oldest: '1767139200',
            latest: '1767312000',
            maxPages: 5,
          },
        ],
      ],
      taskCalls: [],
      postCalls: [],
      updateCalls: [
        [
          { channel: 'C9', ts: 'existing-ts' },
          {
            text: '✅ Queue depth (解決)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#2da44e',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '✅ Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n解決' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                starts_at: INCIDENT_START,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
    })
  })

  it('reuses an existing panel image when updating an alert', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(
      okAsync({
        ref: { channel: 'C9', ts: 'existing-ts' },
        eventPayload: {
          fingerprint: 'fp-queue',
          starts_at: INCIDENT_START,
          task_id: TQ_TASK_REF.id,
          task_number: TQ_TASK_REF.number,
          panel_image_file_id: 'FEXISTING',
        },
      }),
    )
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(
          okAsync({ buffer: Buffer.from('png-data'), panelId: '13' }),
        ),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, createTqClient(), panelImageRenderer),
      {
        alerts: [
          {
            ...ALERT,
            annotations: { ...ALERT.annotations, __panelId__: '13' },
          },
        ],
      },
    )

    expect(
      observeDispatch(outcome, {
        renderCalls: panelImageRenderer.render.mock.calls,
        uploadCalls: notifier.uploadImage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      renderCalls: [],
      uploadCalls: [],
      updateCalls: [
        [
          { channel: 'C9', ts: 'existing-ts' },
          expectedAlertContent('FEXISTING'),
        ],
      ],
    })
  })

  it('creates a new task and message for a later incident with the same fingerprint', async () => {
    const notifier = createNotifier()
    const earlierIncident = {
      ref: { channel: 'C9', ts: 'existing-ts' },
      eventPayload: {
        fingerprint: 'fp-queue',
        starts_at: INCIDENT_START,
        task_id: TQ_TASK_REF.id,
        task_number: TQ_TASK_REF.number,
      },
    }
    notifier.findMessageByMetadata.mockImplementation((_eventType, matcher) =>
      matcher(earlierIncident.eventPayload)
        ? okAsync(earlierIncident)
        : okAsync(null),
    )
    const tqClient = createTqClient()
    const nextIncidentStart = '2026-01-02T00:00:00Z'
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [{ ...ALERT, startsAt: nextIncidentStart }],
    })

    expect(
      observeDispatch(outcome, {
        matcherCalls: matcherCalls(
          notifier.findMessageByMetadata.mock.calls,
          nextIncidentStart,
        ),
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      matcherCalls: [
        [
          'grafana_alert',
          true,
          false,
          false,
          {
            oldest: '1767225600',
            latest: '1767398400',
            maxPages: 5,
          },
        ],
      ],
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              `Started at: ${nextIncidentStart}`,
              'Labels:\n- alertname: Queue depth',
              'Annotations:\n- summary: Queue is growing',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                starts_at: nextIncidentStart,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
      updateCalls: [],
    })
  })

  it('serializes simultaneous deliveries for the same incident', async () => {
    const notifier = createNotifier()
    const messageRef = { channel: 'C1', ts: 'message-ts' }
    let existingPayload: Record<string, unknown> | null = null
    notifier.findMessageByMetadata.mockImplementation((_eventType, matcher) =>
      okAsync(
        existingPayload !== null && matcher(existingPayload)
          ? { ref: messageRef, eventPayload: existingPayload }
          : null,
      ),
    )
    notifier.postMessage.mockImplementation((content) => {
      existingPayload = content.metadata?.event_payload ?? null
      return okAsync(messageRef)
    })
    const tqClient = createTqClient()
    const ctx = createContext(notifier, tqClient)
    const [firstOutcome, secondOutcome] = await Promise.all([
      dispatchOutcome(ctx, { alerts: [ALERT] }),
      dispatchOutcome(ctx, { alerts: [ALERT] }),
    ])
    const expectedContent = {
      text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
      color: '#d73a49',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 Queue depth' },
        },
        {
          type: 'section',
          fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            },
          ],
        },
      ],
      metadata: {
        event_type: 'grafana_alert',
        event_payload: {
          fingerprint: 'fp-queue',
          starts_at: INCIDENT_START,
          task_id: '00000000-0000-4000-8000-000000000009',
          task_number: 9,
        },
      },
    }

    expect(
      observeDispatch([firstOutcome, secondOutcome], {
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: ['notified', 'notified'],
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              `Started at: ${INCIDENT_START}`,
              'Labels:\n- alertname: Queue depth',
              'Annotations:\n- summary: Queue is growing',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [[expectedContent]],
      updateCalls: [[messageRef, expectedContent]],
    })
  })

  it('creates one task and message for each alert in a grouped payload', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'Queue depth' },
          annotations: {},
          fingerprint: 'fp-queue',
          startsAt: INCIDENT_START,
        },
        {
          status: 'firing',
          labels: { alertname: 'Disk usage' },
          annotations: {},
          fingerprint: 'fp-disk',
          startsAt: INCIDENT_START,
        },
      ],
    })

    expect(
      observeDispatch(outcome, {
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              `Started at: ${INCIDENT_START}`,
              'Labels:\n- alertname: Queue depth',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
        [
          {
            title: 'Grafana alert: Disk usage',
            description: [
              'Alert: Disk usage',
              'Status: firing',
              `Started at: ${INCIDENT_START}`,
              'Labels:\n- alertname: Disk usage',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                starts_at: INCIDENT_START,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
        [
          {
            text: '🚨 Disk usage (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Disk usage' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-disk',
                starts_at: INCIDENT_START,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
    })
  })

  it('posts the alert without a task link when tq task creation fails', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient(
      errAsync(new TqApiError('tq unavailable', undefined)),
    )
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [ALERT],
    })

    expect(
      observeDispatch(outcome, {
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          {
            title: 'Grafana alert: Queue depth',
            description: [
              'Alert: Queue depth',
              'Status: firing',
              `Started at: ${INCIDENT_START}`,
              'Labels:\n- alertname: Queue depth',
              'Annotations:\n- summary: Queue is growing',
            ].join('\n\n'),
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Queue depth (発生中)\n未対応',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Queue depth' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*概要*\nQueue is growing' },
              },
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: '*状態*\n未対応' }],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-queue',
                starts_at: INCIDENT_START,
              },
            },
          },
        ],
      ],
    })
  })

  it('ignores a payload without valid Grafana alerts', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'Queue depth' },
          annotations: {},
          fingerprint: 'fp-no-start',
        },
      ],
    })

    expect(
      observeDispatch(outcome, {
        lookupCalls: notifier.findMessageByMetadata.mock.calls,
        taskCalls: tqClient.createTask.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'ignored',
      lookupCalls: [],
      taskCalls: [],
      postCalls: [],
    })
  })

  it('continues notifying later alerts after a Slack post fails', async () => {
    const notifier = createNotifier()
    notifier.postMessage
      .mockReturnValueOnce(errAsync(new SlackApiError('Slack unavailable')))
      .mockReturnValueOnce(okAsync({ channel: 'C1', ts: '2' }))
    const tqClient = createTqClient()
    const result = await dispatch(createContext(notifier, tqClient), {
      alerts: [
        {
          status: 'firing',
          labels: {},
          annotations: {},
          fingerprint: 'fp-first',
          startsAt: INCIDENT_START,
        },
        {
          status: 'firing',
          labels: {},
          annotations: {},
          fingerprint: 'fp-second',
          startsAt: INCIDENT_START,
        },
      ],
    })

    expect(
      observeDispatch(
        result.match(
          (outcome) => ({ outcome }),
          (error) => ({ error: error.name, message: error.message }),
        ),
        {
          taskCalls: tqClient.createTask.mock.calls,
          postCalls: notifier.postMessage.mock.calls,
          updateCalls: notifier.updateMessage.mock.calls,
        },
      ),
    ).toEqual({
      outcome: { error: 'SlackApiError', message: 'Slack unavailable' },
      taskCalls: [
        [
          {
            title: 'Grafana alert: Grafana alert',
            description: `Alert: Grafana alert\n\nStatus: firing\n\nStarted at: ${INCIDENT_START}`,
            context: 'personal',
          },
        ],
        [
          {
            title: 'Grafana alert: Grafana alert',
            description: `Alert: Grafana alert\n\nStatus: firing\n\nStarted at: ${INCIDENT_START}`,
            context: 'personal',
          },
        ],
      ],
      postCalls: [
        [
          {
            text: '🚨 Grafana alert (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Grafana alert' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-first',
                starts_at: INCIDENT_START,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
        [
          {
            text: '🚨 Grafana alert (発生中)\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
            color: '#d73a49',
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: '🚨 Grafana alert' },
              },
              {
                type: 'section',
                fields: [{ type: 'mrkdwn', text: '*状態*\n発生中' }],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '*状態*\n未対応 · <https://tasks.example.test/tasks/00000000-0000-4000-8000-000000000009|tq #9>',
                  },
                ],
              },
            ],
            metadata: {
              event_type: 'grafana_alert',
              event_payload: {
                fingerprint: 'fp-second',
                starts_at: INCIDENT_START,
                task_id: '00000000-0000-4000-8000-000000000009',
                task_number: 9,
              },
            },
          },
        ],
      ],
      updateCalls: [],
    })
  })

  it('returns a Slack history lookup failure without creating tasks or messages', async () => {
    const notifier = createNotifier()
    notifier.findMessageByMetadata.mockReturnValue(
      errAsync(new SlackApiError('history unavailable')),
    )
    const tqClient = createTqClient()
    const result = await dispatch(createContext(notifier, tqClient), {
      alerts: [ALERT],
    })

    expect(
      observeDispatch(
        result.match(
          (outcome) => ({ outcome }),
          (error) => ({ error: error.name, message: error.message }),
        ),
        {
          taskCalls: tqClient.createTask.mock.calls,
          postCalls: notifier.postMessage.mock.calls,
          updateCalls: notifier.updateMessage.mock.calls,
        },
      ),
    ).toEqual({
      outcome: { error: 'SlackApiError', message: 'history unavailable' },
      taskCalls: [],
      postCalls: [],
      updateCalls: [],
    })
  })
})
