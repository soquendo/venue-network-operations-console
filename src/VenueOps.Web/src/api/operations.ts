export type TelemetrySource = 'simulated' | 'measured' | 'derived'
export type AlertState = 'inactive' | 'pending' | 'firing'

export interface AccessPointObservation {
  apId: string
  zone: string
  operational: boolean
  clients: number
  channelUtilizationRatio: number | null
  managementLatencySeconds: number | null
  managementPacketLossRatio: number | null
  alertState: AlertState
  source: TelemetrySource
  observedAtUtc: string
}

export interface ZoneObservation {
  zone: string
  operationalRatio: number
  clients: number
  source: TelemetrySource
  observedAtUtc: string
}

export interface ProbeObservation {
  target: string
  success: boolean
  durationSeconds: number
  httpStatusCode: number
  source: TelemetrySource
  observedAtUtc: string
}

export interface ScrapeObservation {
  up: boolean
  value: number
  source: TelemetrySource
  observedAtUtc: string
}

export interface OperationsOverview {
  generatedAtUtc: string
  accessPoints: AccessPointObservation[]
  zones: ZoneObservation[]
  probe: ProbeObservation
  simulatorScrape: ScrapeObservation
}

export type HistoryWindow = '15m' | '1h' | '6h' | '24h'

export interface AccessPointHistorySample {
  observedAtUtc: string
  operational: boolean
  clients: number
  channelUtilizationRatio: number | null
  managementLatencySeconds: number | null
  managementPacketLossRatio: number | null
}

export interface AccessPointHistory {
  apId: string
  zone: string
  window: HistoryWindow
  startUtc: string
  endUtc: string
  stepSeconds: number
  source: TelemetrySource
  samples: AccessPointHistorySample[]
}

interface ProblemDetails {
  detail?: string
  title?: string
}

export async function getOperationsOverview(signal?: AbortSignal): Promise<OperationsOverview> {
  const response = await fetch('/api/operations/overview', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    let problem: ProblemDetails | undefined
    try {
      problem = (await response.json()) as ProblemDetails
    } catch {
      // A non-JSON error still becomes an explicit failed request below.
    }

    throw new Error(
      problem?.detail ??
        problem?.title ??
        `The operations API returned HTTP ${response.status}.`,
    )
  }

  return (await response.json()) as OperationsOverview
}

export async function getAccessPointHistory(
  apId: string,
  window: HistoryWindow,
  signal?: AbortSignal,
): Promise<AccessPointHistory> {
  const query = new URLSearchParams({ window })
  const response = await fetch(
    `/api/operations/access-points/${encodeURIComponent(apId)}/history?${query}`,
    {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    },
  )

  if (!response.ok) {
    let problem: ProblemDetails | undefined
    try {
      problem = (await response.json()) as ProblemDetails
    } catch {
      // A non-JSON error still becomes an explicit failed request below.
    }

    throw new Error(
      problem?.detail ??
        problem?.title ??
        `The history API returned HTTP ${response.status}.`,
    )
  }

  return (await response.json()) as AccessPointHistory
}
