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
  it.each([
    {
      pathType: 'without a slug',
      panelURL:
        'https://grafana.example.test/d/url-board?from=100&orgId=9&to=200&viewPanel=23',
    },
    {
      pathType: 'with a slug',
      panelURL:
        'https://grafana.example.test/d/url-board/queue-depth?from=100&orgId=9&to=200&viewPanel=23',
    },
  ])(
    'reads the panel identity from a panelURL $pathType',
    async ({ panelURL }) => {
      const imageData = Buffer.from([80, 78, 71])
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(imageData, {
          headers: { 'content-type': 'image/png' },
        }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const renderer = createGrafanaPanelImageRenderer(
        'service-token',
        'https://grafana.example.test',
      )
      const result = await renderer
        .render({ ...ALERT, annotations: {}, panelURL })
        .match(
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
        result: { kind: 'image', panelId: '23', bytes: [80, 78, 71] },
        requests: [
          {
            url: 'https://grafana.example.test/render/d-solo/url-board?panelId=23&width=1200&height=600&from=now-1h&to=now',
            headers: { Authorization: 'Bearer service-token' },
          },
        ],
      })
    },
  )

  it.each([
    { urlState: 'absent', panelURL: undefined },
    {
      urlState: 'missing a viewPanel ID',
      panelURL: 'https://grafana.example.test/d/url-board?orgId=9',
    },
  ])('uses annotations when panelURL is $urlState', async ({ panelURL }) => {
    const imageData = Buffer.from([80, 78, 71])
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(imageData, {
        headers: { 'content-type': 'image/png' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const renderer = createGrafanaPanelImageRenderer(
      'service-token',
      'https://grafana.example.test',
    )
    const result = await renderer
      .render({ ...ALERT, ...(panelURL === undefined ? {} : { panelURL }) })
      .match(
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
          url: 'https://grafana.example.test/render/d-solo/queue-board?panelId=13&width=1200&height=600&from=now-1h&to=now',
          headers: { Authorization: 'Bearer service-token' },
        },
      ],
    })
  })

  it('returns the HTTP error when Grafana rejects the render request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createGrafanaPanelImageRenderer(
      'service-token',
      'https://grafana.example.test',
    )
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

  it('returns an error when Grafana responds with a non-PNG body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>login</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await createGrafanaPanelImageRenderer(
      'service-token',
      'https://grafana.example.test',
    )
      .render(ALERT)
      .match(
        (image) => ({ kind: 'image', panelId: image.panelId }),
        (error) => ({ kind: 'error', message: error.message }),
      )

    expect(result).toEqual({
      kind: 'error',
      message: 'Grafana render API did not return a PNG image',
    })
  })

  it('returns an error when the Grafana URL is invalid', async () => {
    const result = await createGrafanaPanelImageRenderer(
      'service-token',
      'invalid-url',
    )
      .render(ALERT)
      .match(
        (image) => ({ kind: 'image', panelId: image.panelId }),
        (error) => ({ kind: 'error', message: error.message }),
      )

    expect(result).toEqual({
      kind: 'error',
      message: 'failed to build Grafana render URL',
    })
  })
})
