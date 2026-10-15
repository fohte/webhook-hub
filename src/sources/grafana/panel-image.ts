import { err, errAsync, ok, Result, ResultAsync } from 'neverthrow'

import type { GrafanaAlert } from '#sources/grafana/handlers/alert'

const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 600
const REQUEST_TIMEOUT_MS = 15_000
const PANEL_ID_PATTERN = /^\d+$/

const buildRenderUrl = Result.fromThrowable(
  (baseUrl: string, dashboardUid: string, panelId: string): URL => {
    const url = new URL(
      `/render/d-solo/${encodeURIComponent(dashboardUid)}`,
      baseUrl,
    )
    url.searchParams.set('panelId', panelId)
    url.searchParams.set('width', String(IMAGE_WIDTH))
    url.searchParams.set('height', String(IMAGE_HEIGHT))
    url.searchParams.set('from', 'now-1h')
    url.searchParams.set('to', 'now')
    return url
  },
  (caughtErr) =>
    new GrafanaPanelImageError('failed to build Grafana render URL', caughtErr),
)

interface GrafanaPanelImage {
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

type GrafanaPanelIdentity = { dashboardUid: string; panelId: string }

const readPanelUrlIdentity = Result.fromThrowable(
  (panelURL: string): GrafanaPanelIdentity | undefined => {
    const url = new URL(panelURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

    const [route, encodedDashboardUid] = url.pathname.split('/').slice(1)
    const panelId = url.searchParams.get('viewPanel')
    if (
      route !== 'd' ||
      encodedDashboardUid === undefined ||
      encodedDashboardUid === '' ||
      panelId === null ||
      !PANEL_ID_PATTERN.test(panelId)
    ) {
      return undefined
    }

    const dashboardUid = decodeURIComponent(encodedDashboardUid)
    return dashboardUid === '' ? undefined : { dashboardUid, panelId }
  },
  (caughtErr) =>
    new GrafanaPanelImageError('failed to parse Grafana panel URL', caughtErr),
)

const readAnnotationPanelId = (alert: GrafanaAlert): string | undefined => {
  const panelId = alert.annotations['__panelId__']
  return panelId !== undefined && PANEL_ID_PATTERN.test(panelId)
    ? panelId
    : undefined
}

const readAnnotationPanelIdentity = (
  alert: GrafanaAlert,
): Result<GrafanaPanelIdentity, GrafanaPanelImageError> => {
  const dashboardUid = alert.annotations['__dashboardUid__']
  const panelId = readAnnotationPanelId(alert)
  if (
    dashboardUid === undefined ||
    dashboardUid === '' ||
    panelId === undefined
  ) {
    return err(
      new GrafanaPanelImageError(
        'Grafana alert is missing a valid dashboard UID or panel ID',
      ),
    )
  }
  return ok({ dashboardUid, panelId })
}

const readPanelIdentity = (
  alert: GrafanaAlert,
): Result<GrafanaPanelIdentity, GrafanaPanelImageError> => {
  if (alert.panelURL !== undefined) {
    const panelUrlIdentity = readPanelUrlIdentity(alert.panelURL)
    if (panelUrlIdentity.isOk() && panelUrlIdentity.value !== undefined) {
      return ok(panelUrlIdentity.value)
    }
  }

  return readAnnotationPanelIdentity(alert)
}

export const readPanelId = (alert: GrafanaAlert): string | undefined =>
  readPanelIdentity(alert).match(
    ({ panelId }) => panelId,
    () => readAnnotationPanelId(alert),
  )

export const createGrafanaPanelImageRenderer = (
  token: string,
  baseUrl: string,
): GrafanaPanelImageRenderer => ({
  render(alert) {
    const identity = readPanelIdentity(alert)
    if (identity.isErr()) return errAsync(identity.error)

    const { dashboardUid, panelId } = identity.value
    const url = buildRenderUrl(baseUrl, dashboardUid, panelId)
    if (url.isErr()) return errAsync(url.error)

    return ResultAsync.fromPromise(
      fetch(url.value, {
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
