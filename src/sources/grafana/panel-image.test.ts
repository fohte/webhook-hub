import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GrafanaAlert } from '#sources/grafana/handlers/alert'
import { createGrafanaPanelImageRenderer } from '#sources/grafana/panel-image'

const ALERT: GrafanaAlert = {
  status: 'firing',
  labels: { alertname: 'Queue depth' },
  annotations: { __dashboardUid__: 'queue-board', __panelId__: '13' },
  fingerprint: 'fp-queue',
  startsAt: '2026-01-01T00:00:00Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const observeRender = <TResult, TRequests>(
  result: TResult,
  requests: TRequests,
) => ({ result, requests })

describe('createGrafanaPanelImageRenderer', () => {
  it('renders the alert panel as a PNG with a Grafana service token', async () => {
    const imageData = Buffer.from([80, 78, 71])
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(imageData, {
        headers: { 'content-type': 'image/png' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const renderer = createGrafanaPanelImageRenderer('service-token')
    const result = await renderer.render(ALERT).match(
      (image) => ({
        kind: 'image',
        panelId: image.panelId,
        bytes: [...image.buffer],
      }),
      (error) => ({ kind: 'error', message: error.message }),
    )

    expect(
      observeRender(
        result,
        fetchMock.mock.calls.map(([url, init]) => ({
          url: url instanceof URL ? url.href : url,
          headers: init?.headers,
        })),
      ),
    ).toEqual({
      result: { kind: 'image', panelId: '13', bytes: [80, 78, 71] },
      requests: [
        {
          url: 'https://fohte.grafana.net/render/d-solo/queue-board?panelId=13&width=1200&height=600&from=now-1h&to=now',
          headers: { Authorization: 'Bearer service-token' },
        },
      ],
    })
  })

  it('returns an error when Grafana does not return a PNG', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createGrafanaPanelImageRenderer('service-token')
      .render(ALERT)
      .match(
        (image) => ({ kind: 'image', panelId: image.panelId }),
        (error) => ({ kind: 'error', message: error.message }),
      )

    expect(result).toEqual({
      kind: 'error',
      message: 'Grafana render API returned HTTP 404',
    })
  })
})
