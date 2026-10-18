import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import {
  addTqTaskStatus,
  TQ_ORIGINAL_CONTENT_KEY,
  type TqTaskStatusInfo,
} from '#plugins/tq/alert-task'
import {
  type DecodedSlackMessageContent,
  expectedTqOriginalContentSnapshot,
  normalizeTqOriginalContentSnapshot,
} from '#plugins/tq/alert-task-test-support'
import { TqApiError, type TqClient } from '#plugins/tq/tq-client'
import {
  SlackApiError,
  type SlackMessageContent,
  type SlackMessageRef,
  type SlackNotifier,
} from '#slack'
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
const TASK_COMPLETED_AT = '2026-01-02T03:04:05Z'
const TASK_COMPLETED_DATE =
  '<!date^1767323045^{date_short} {time}|2026-01-02 03:04 UTC>'
const ALERT = {
  status: 'firing',
  labels: { alertname: 'Queue depth' },
  annotations: { summary: 'Queue is growing' },
  fingerprint: 'fp-queue',
  startsAt: INCIDENT_START,
}

const expectedGrafanaTask = ({
  alertName,
  summary,
  startedAtJst,
  panelURL,
}: {
  alertName: string
  summary?: string
  startedAtJst: string
  panelURL?: string
}) => {
  const title = summary === undefined || summary === '' ? alertName : summary
  const actionDetails = [
    ...(panelURL === undefined ? [] : [`- Panel: ${panelURL}`]),
  ]

  return {
    title,
    description: [
      '## なぜやるか',
      '',
      title,
      '',
      `- 開始: ${startedAtJst}`,
      '',
      '## やること',
      '',
      'グラフで状況を確かめ、原因を取り除く。',
      ...(actionDetails.length === 0 ? [] : ['', ...actionDetails]),
      '',
      '## 完了条件',
      '',
      '- [ ] アラートが resolved になる',
    ].join('\n'),
    context: 'personal',
    labels: ['alert/grafana'],
  }
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
  const findMessagesByMetadata = vi
    .fn<SlackNotifier['findMessagesByMetadata']>()
    .mockReturnValue(okAsync([]))
  const uploadImage = vi
    .fn<SlackNotifier['uploadImage']>()
    .mockReturnValue(okAsync('FIMAGE'))
  return {
    postMessage,
    updateMessage,
    findMessageByMetadata,
    findMessagesByMetadata,
    uploadImage,
  }
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

type DispatchObservations = {
  postCalls?: [SlackMessageContent][]
  updateCalls?: [SlackMessageRef, SlackMessageContent][]
}

const normalizeCalls = (
  calls: [SlackMessageContent][],
): [DecodedSlackMessageContent][] =>
  calls.map(([content]) => [normalizeTqOriginalContentSnapshot(content)])

const normalizeUpdateCalls = (
  calls: [SlackMessageRef, SlackMessageContent][],
): [SlackMessageRef, DecodedSlackMessageContent][] =>
  calls.map(([ref, content]) => [
    ref,
    normalizeTqOriginalContentSnapshot(content),
  ])

const observeDispatch = <TOutcome, TObservations extends DispatchObservations>(
  outcome: TOutcome,
  observations: TObservations,
) => ({
  outcome,
  ...observations,
  ...(observations.postCalls === undefined
    ? {}
    : { postCalls: normalizeCalls(observations.postCalls) }),
  ...(observations.updateCalls === undefined
    ? {}
    : { updateCalls: normalizeUpdateCalls(observations.updateCalls) }),
})

const expectedTodoGrafanaContent = (options: {
  alertName: string
  fingerprint: string
  startsAt: string
  summary?: string
  task?: typeof TQ_TASK_REF | null
  imageFileId?: string
  panelId?: string
  panelURL?: string
}) => {
  const task = options.task === undefined ? TQ_TASK_REF : options.task

  return {
    text: [
      options.alertName,
      ...(options.summary === undefined ? [] : [options.summary]),
    ].join('\n'),
    color: '#d73a49',
    blocks: [
      {
        type: 'header' as const,
        text: { type: 'plain_text' as const, text: options.alertName },
      },
      ...(options.summary === undefined
        ? []
        : [
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: options.summary,
              },
            },
          ]),
      ...(options.imageFileId === undefined
        ? []
        : [
            {
              type: 'image' as const,
              slack_file: { id: options.imageFileId },
              alt_text: `Grafana panel ${options.panelId ?? '13'}`,
            },
          ]),
      ...(options.panelURL === undefined
        ? []
        : [
            {
              type: 'context' as const,
              elements: [
                {
                  type: 'mrkdwn' as const,
                  text: `<${options.panelURL}|Panel>`,
                },
              ],
            },
          ]),
    ],
    username: 'Grafana',
    iconUrl: 'https://grafana.com/static/assets/img/fav32.png',
    metadata: {
      event_type: 'grafana_alert',
      event_payload: {
        fingerprint: options.fingerprint,
        starts_at: options.startsAt,
        grafana_status: 'firing',
        ...(task === null
          ? {}
          : {
              task_id: task.id,
              task_number: task.number,
              tq_task_status: 'todo',
              tq_task_status_reason: 'none',
            }),
        ...(options.imageFileId === undefined
          ? {}
          : { panel_image_file_id: options.imageFileId }),
      },
    },
    ...(task === null
      ? {}
      : {
          additionalAttachments: [
            {
              text: `<${TQ_WEB_URL}/tasks/${task.id}|tq #${String(task.number)}> · todo`,
              color: '#2eb67d',
              blocks: [
                {
                  type: 'context' as const,
                  elements: [
                    {
                      type: 'mrkdwn' as const,
                      text: `<${TQ_WEB_URL}/tasks/${task.id}|tq #${String(task.number)}> · todo`,
                    },
                  ],
                },
              ],
            },
          ],
        }),
  }
}

const expectedFoldedGrafanaContent = (options: {
  alertName: string
  fingerprint: string
  startsAt: string
  summary?: string
  task?: typeof TQ_TASK_REF | null
  panelURL?: string
}) => {
  const original = expectedTodoGrafanaContent(options)
  const title = `*~${options.alertName}~*`
  const linkBlocks = original.blocks.filter(
    (block) =>
      block.type === 'context' &&
      block.elements.some((element) =>
        /<https?:\/\/[^>]+>/u.test(element.text),
      ),
  )
  const linkText = linkBlocks.flatMap((block) =>
    block.type === 'context'
      ? block.elements.map((element) => element.text)
      : [],
  )

  return {
    ...original,
    text: [title, ...linkText].join('\n'),
    color: '#2eb67d',
    blocks: [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: title },
      },
      ...linkBlocks,
    ],
    metadata: {
      ...original.metadata,
      event_payload: {
        ...original.metadata.event_payload,
        grafana_status: 'resolved',
        [TQ_ORIGINAL_CONTENT_KEY]: expectedTqOriginalContentSnapshot(original),
      },
    },
  }
}

const expectedAlertContent = (
  imageFileId?: string,
  options: { panelId?: string; panelURL?: string } = {},
) =>
  expectedTodoGrafanaContent({
    alertName: 'Queue depth',
    fingerprint: 'fp-queue',
    startsAt: INCIDENT_START,
    summary: 'Queue is growing',
    ...options,
    ...(imageFileId === undefined ? {} : { imageFileId }),
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
          expectedGrafanaTask({
            alertName: 'Queue depth',
            summary: 'Queue is growing',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
        ],
      ],
      postCalls: [[expectedAlertContent()]],
      updateCalls: [],
    })
  })

  it('posts resolved alerts folded without rendering an undisplayed panel image', async () => {
    const notifier = createNotifier()
    const tqClient = createTqClient()
    const alertName = 'Worker retry surge'
    const summary = 'Retries exceeded the rolling budget'
    const startsAt = '2026-07-08T14:15:16Z'
    const panelURL =
      'https://observability.example.test/d/worker-retries?viewPanel=4'
    const alert = {
      status: 'resolved',
      labels: { alertname: alertName },
      annotations: { summary },
      fingerprint: 'fp-worker-retry',
      startsAt,
      panelURL,
    }
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(
          okAsync({ buffer: Buffer.from('png-data'), panelId: '7' }),
        ),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, tqClient, panelImageRenderer),
      { alerts: [alert] },
    )

    expect(
      observeDispatch(outcome, {
        taskCalls: tqClient.createTask.mock.calls,
        renderCalls: panelImageRenderer.render.mock.calls,
        uploadCalls: notifier.uploadImage.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      taskCalls: [
        [
          expectedGrafanaTask({
            alertName,
            summary,
            startedAtJst: '2026-07-08 23:15 JST',
            panelURL,
          }),
        ],
      ],
      renderCalls: [],
      uploadCalls: [],
      postCalls: [
        [
          expectedFoldedGrafanaContent({
            alertName,
            fingerprint: 'fp-worker-retry',
            startsAt,
            summary,
            panelURL,
          }),
        ],
      ],
      updateCalls: [],
    })
  })

  it('places an uploaded panel image before the Panel link', async () => {
    const notifier = createNotifier()
    const imageBuffer = Buffer.from('png-data')
    const panelURL =
      'https://observability.example.test/d/queue-depth?viewPanel=13'
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(okAsync({ buffer: imageBuffer, panelId: '13' })),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, createTqClient(), panelImageRenderer),
      { alerts: [{ ...ALERT, panelURL }] },
    )

    expect(
      observeDispatch(outcome, {
        renderCalls: panelImageRenderer.render.mock.calls,
        uploadCalls: notifier.uploadImage.mock.calls,
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      renderCalls: [[{ ...ALERT, panelURL }]],
      uploadCalls: [
        [
          {
            data: imageBuffer,
            filename: 'grafana-panel-13.png',
            altText: 'Grafana panel 13',
          },
        ],
      ],
      postCalls: [[expectedAlertContent('FIMAGE', { panelURL })]],
    })
  })

  it('retries a new notification without the panel image when posting it fails', async () => {
    const notifier = createNotifier()
    notifier.postMessage
      .mockReturnValueOnce(errAsync(new SlackApiError('invalid image block')))
      .mockReturnValueOnce(okAsync({ channel: 'C1', ts: '1' }))
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(
          okAsync({ buffer: Buffer.from('png-data'), panelId: '13' }),
        ),
    }
    const outcome = await dispatchOutcome(
      createContext(notifier, createTqClient(), panelImageRenderer),
      { alerts: [ALERT] },
    )

    expect(
      observeDispatch(outcome, {
        postCalls: notifier.postMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      postCalls: [[expectedAlertContent('FIMAGE')], [expectedAlertContent()]],
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

  it('folds a resolved source alert while preserving the closed task status', async () => {
    const notifier = createNotifier()
    const panelURL = 'https://grafana.example.test/d/worker-queue?viewPanel=7'
    const firingContent = expectedAlertContent(undefined, { panelURL })
    const completedInfo: TqTaskStatusInfo = {
      task: TQ_TASK_REF,
      status: 'completed',
      statusReason: 'completed',
      occurredAt: TASK_COMPLETED_AT,
    }
    const closedFiringContent = addTqTaskStatus(
      firingContent,
      TQ_TASK_REF,
      TQ_WEB_URL,
      firingContent.metadata,
      completedInfo,
    )
    const closedFiringMetadata = closedFiringContent.metadata
    if (closedFiringMetadata === undefined) {
      throw new Error('Grafana alert metadata is missing')
    }
    notifier.findMessageByMetadata.mockReturnValue(
      okAsync({
        ref: { channel: 'C9', ts: 'existing-ts' },
        content: closedFiringContent,
        eventPayload: closedFiringMetadata.event_payload,
      }),
    )
    const tqClient = createTqClient()
    const outcome = await dispatchOutcome(createContext(notifier, tqClient), {
      alerts: [{ ...ALERT, status: 'resolved', panelURL }],
    })
    const expectedResolved = expectedFoldedGrafanaContent({
      alertName: 'Queue depth',
      fingerprint: 'fp-queue',
      startsAt: INCIDENT_START,
      summary: 'Queue is growing',
      panelURL,
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
            ...expectedResolved,
            additionalAttachments: [
              {
                text: `~<${TQ_WEB_URL}/tasks/${TQ_TASK_REF.id}|tq #9>~ · completed ${TASK_COMPLETED_DATE}`,
                color: '#8250df',
                blocks: [
                  {
                    type: 'context',
                    elements: [
                      {
                        type: 'mrkdwn',
                        text: `~<${TQ_WEB_URL}/tasks/${TQ_TASK_REF.id}|tq #9>~ · completed ${TASK_COMPLETED_DATE}`,
                      },
                    ],
                  },
                ],
              },
            ],
            metadata: {
              ...expectedResolved.metadata,
              event_payload: {
                ...expectedResolved.metadata.event_payload,
                tq_task_status: 'completed',
                tq_task_status_reason: 'completed',
                tq_task_occurred_at: TASK_COMPLETED_AT,
              },
            },
          },
        ],
      ],
    })
  })

  it('unfolds the existing alert when the same fingerprint fires again', async () => {
    const notifier = createNotifier()
    const alertName = 'Stream parser reconnects'
    const summary = 'Reconnect attempts exceeded the target'
    const startsAt = '2026-07-09T15:16:17Z'
    const panelURL =
      'https://observability.example.test/d/stream-parser?viewPanel=6'
    const alert = {
      status: 'firing',
      labels: { alertname: alertName },
      annotations: { summary },
      fingerprint: 'fp-stream-reconnect',
      startsAt,
      panelURL,
    }
    const tqClient = createTqClient()
    const firingContent = expectedTodoGrafanaContent({
      alertName,
      fingerprint: 'fp-stream-reconnect',
      startsAt,
      summary,
      panelURL,
    })
    const firingMetadata = firingContent.metadata
    const ref = { channel: 'C9', ts: 'existing-ts' }
    notifier.findMessageByMetadata.mockReturnValueOnce(
      okAsync({
        ref,
        content: firingContent,
        eventPayload: firingMetadata.event_payload,
      }),
    )

    const resolvedOutcome = await dispatchOutcome(
      createContext(notifier, tqClient),
      { alerts: [{ ...alert, status: 'resolved' }] },
    )
    const resolvedContent = notifier.updateMessage.mock.calls[0]?.[1]
    notifier.findMessageByMetadata.mockReturnValueOnce(
      okAsync({
        ref,
        eventPayload:
          resolvedContent?.metadata?.event_payload ??
          firingMetadata.event_payload,
      }),
    )

    const firingOutcome = await dispatchOutcome(
      createContext(notifier, tqClient),
      {
        alerts: [alert],
      },
    )

    expect(
      observeDispatch([resolvedOutcome, firingOutcome], {
        taskCalls: tqClient.createTask.mock.calls,
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: ['notified', 'notified'],
      taskCalls: [],
      updateCalls: [
        [
          ref,
          expectedFoldedGrafanaContent({
            alertName,
            fingerprint: 'fp-stream-reconnect',
            startsAt,
            summary,
            panelURL,
          }),
        ],
        [
          ref,
          expectedTodoGrafanaContent({
            alertName,
            fingerprint: 'fp-stream-reconnect',
            startsAt,
            summary,
            panelURL,
          }),
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
            panelURL: 'https://grafana.example.test/d/url-board?viewPanel=23',
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
          expectedAlertContent('FEXISTING', {
            panelId: '23',
            panelURL: 'https://grafana.example.test/d/url-board?viewPanel=23',
          }),
        ],
      ],
    })
  })

  it('retries an alert update without the panel image when updating it fails', async () => {
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
    notifier.updateMessage
      .mockReturnValueOnce(errAsync(new SlackApiError('invalid image block')))
      .mockReturnValueOnce(okAsync(undefined))
    const outcome = await dispatchOutcome(createContext(notifier), {
      alerts: [
        {
          ...ALERT,
          annotations: { ...ALERT.annotations, __panelId__: '13' },
        },
      ],
    })

    expect(
      observeDispatch(outcome, {
        updateCalls: notifier.updateMessage.mock.calls,
      }),
    ).toEqual({
      outcome: 'notified',
      updateCalls: [
        [
          { channel: 'C9', ts: 'existing-ts' },
          expectedAlertContent('FEXISTING'),
        ],
        [{ channel: 'C9', ts: 'existing-ts' }, expectedAlertContent()],
      ],
    })
  })

  it('returns the body-only retry error when both notification attempts fail', async () => {
    const notifier = createNotifier()
    notifier.postMessage
      .mockReturnValueOnce(errAsync(new SlackApiError('invalid image block')))
      .mockReturnValueOnce(errAsync(new SlackApiError('Slack unavailable')))
    const panelImageRenderer = {
      render: vi
        .fn()
        .mockReturnValue(
          okAsync({ buffer: Buffer.from('png-data'), panelId: '13' }),
        ),
    }
    const result = await dispatch(
      createContext(notifier, createTqClient(), panelImageRenderer),
      { alerts: [ALERT] },
    )

    expect(
      observeDispatch(
        result.match(
          (outcome) => ({ outcome }),
          (error) => ({ error: error.name, message: error.message }),
        ),
        { postCalls: notifier.postMessage.mock.calls },
      ),
    ).toEqual({
      outcome: { error: 'SlackApiError', message: 'Slack unavailable' },
      postCalls: [[expectedAlertContent('FIMAGE')], [expectedAlertContent()]],
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
          expectedGrafanaTask({
            alertName: 'Queue depth',
            summary: 'Queue is growing',
            startedAtJst: '2026-01-02 09:00 JST',
          }),
        ],
      ],
      postCalls: [
        [
          expectedTodoGrafanaContent({
            alertName: 'Queue depth',
            fingerprint: 'fp-queue',
            startsAt: nextIncidentStart,
            summary: 'Queue is growing',
          }),
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
    const expectedContent = expectedAlertContent()

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
          expectedGrafanaTask({
            alertName: 'Queue depth',
            summary: 'Queue is growing',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
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
          expectedGrafanaTask({
            alertName: 'Queue depth',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
        ],
        [
          expectedGrafanaTask({
            alertName: 'Disk usage',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
        ],
      ],
      postCalls: [
        [
          expectedTodoGrafanaContent({
            alertName: 'Queue depth',
            fingerprint: 'fp-queue',
            startsAt: INCIDENT_START,
            task: TQ_TASK_REF,
          }),
        ],
        [
          expectedTodoGrafanaContent({
            alertName: 'Disk usage',
            fingerprint: 'fp-disk',
            startsAt: INCIDENT_START,
            task: TQ_TASK_REF,
          }),
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
          expectedGrafanaTask({
            alertName: 'Queue depth',
            summary: 'Queue is growing',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
        ],
      ],
      postCalls: [
        [
          expectedTodoGrafanaContent({
            alertName: 'Queue depth',
            fingerprint: 'fp-queue',
            startsAt: INCIDENT_START,
            summary: 'Queue is growing',
            task: null,
          }),
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
          expectedGrafanaTask({
            alertName: 'Grafana alert',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
        ],
        [
          expectedGrafanaTask({
            alertName: 'Grafana alert',
            startedAtJst: '2026-01-01 09:00 JST',
          }),
        ],
      ],
      postCalls: [
        [
          expectedTodoGrafanaContent({
            alertName: 'Grafana alert',
            fingerprint: 'fp-first',
            startsAt: INCIDENT_START,
          }),
        ],
        [
          expectedTodoGrafanaContent({
            alertName: 'Grafana alert',
            fingerprint: 'fp-second',
            startsAt: INCIDENT_START,
          }),
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
