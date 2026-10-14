import { err, errAsync, ok, type Result, ResultAsync } from 'neverthrow'

import type { GrafanaAlert } from '#sources/grafana/handlers/alert'

const GRAFANA_BASE_URL = 'https://fohte.grafana.net'
const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 600
const REQUEST_TIMEOUT_MS = 15_000

export interface GrafanaPanelImage {
  buffer: Buffer
  panelId: string
}

export interface GrafanaPanelImageRenderer {
  render(
    alert: GrafanaAlert,
  ): ResultAsync<GrafanaPanelImage, GrafanaPanelImageError>
}

export class GrafanaPanelImageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'GrafanaPanelImageError'
  }
}

const readPanelIdentity = (
  alert: GrafanaAlert,
): Result<
  { dashboardUid: string; panelId: string },
  GrafanaPanelImageError
> => {
  const dashboardUid = alert.annotations['__dashboardUid__']
  const panelId = alert.annotations['__panelId__']
  if (
    dashboardUid === undefined ||
    dashboardUid === '' ||
    panelId === undefined ||
    !/^\d+$/.test(panelId)
  ) {
    return err(
      new GrafanaPanelImageError(
        'Grafana alert is missing a valid dashboard UID or panel ID',
      ),
    )
  }
  return ok({ dashboardUid, panelId })
}

export const createGrafanaPanelImageRenderer = (
  token: string,
): GrafanaPanelImageRenderer => ({
  render(alert) {
    const identity = readPanelIdentity(alert)
    if (identity.isErr()) return errAsync(identity.error)
    if (token === '') {
      return errAsync(
        new GrafanaPanelImageError('GRAFANA_API_TOKEN is not configured'),
      )
    }

    const { dashboardUid, panelId } = identity.value
    const url = new URL(
      `/render/d-solo/${encodeURIComponent(dashboardUid)}`,
      GRAFANA_BASE_URL,
    )
    url.searchParams.set('panelId', panelId)
    url.searchParams.set('width', String(IMAGE_WIDTH))
    url.searchParams.set('height', String(IMAGE_HEIGHT))
    url.searchParams.set('from', 'now-1h')
    url.searchParams.set('to', 'now')

    return ResultAsync.fromPromise(
      fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      (caughtErr) =>
        new GrafanaPanelImageError(
          'failed to fetch Grafana panel image',
          caughtErr,
        ),
    ).andThen((response) => {
      if (!response.ok) {
        return errAsync(
          new GrafanaPanelImageError(
            `Grafana render API returned HTTP ${String(response.status)}`,
          ),
        )
      }
      const contentType = response.headers.get('content-type')
      if (contentType === null || !contentType.startsWith('image/png')) {
        return errAsync(
          new GrafanaPanelImageError(
            'Grafana render API did not return a PNG image',
          ),
        )
      }

      return ResultAsync.fromPromise(
        response.arrayBuffer(),
        (caughtErr) =>
          new GrafanaPanelImageError(
            'failed to read Grafana panel image',
            caughtErr,
          ),
      ).map((buffer) => ({ buffer: Buffer.from(buffer), panelId }))
    })
  },
})
