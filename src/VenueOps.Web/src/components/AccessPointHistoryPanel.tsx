import { useEffect, useMemo, useState } from 'react'
import {
  getAccessPointHistory,
  type AccessPointHistory,
  type AccessPointHistorySample,
  type AccessPointObservation,
  type HistoryWindow,
} from '../api/operations'

const historyWindows: ReadonlyArray<{ value: HistoryWindow; label: string }> = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
]

interface HistorySelection {
  apId: string
  window: HistoryWindow
}

interface HistoryState {
  selection: HistorySelection
  history: AccessPointHistory | null
  error: string | null
  isLoading: boolean
}

export function AccessPointHistoryPanel({
  accessPoints,
}: {
  accessPoints: AccessPointObservation[]
}) {
  // A new selection object also distinguishes separate visits to the same AP/window.
  const [selection, setSelection] = useState<HistorySelection>(() => ({
    apId: accessPoints[0]?.apId ?? '',
    window: '15m',
  }))
  const [state, setState] = useState<HistoryState>(() => ({
    selection,
    history: null,
    error: null,
    isLoading: true,
  }))
  const { apId: selectedApId, window: historyWindow } = selection
  // Guard the render itself, before the new selection's effect has run.
  const history = state.selection === selection ? state.history : null
  const error = state.selection === selection ? state.error : null
  const isLoading = state.selection === selection ? state.isLoading : true

  useEffect(() => {
    let active = true
    let currentRequest: AbortController | null = null

    const loadHistory = async () => {
      if (!active || currentRequest) return
      const controller = new AbortController()
      currentRequest = controller
      const ownsRequest = () => active && currentRequest === controller
      setState((previous) => ({
        selection,
        history: previous.selection === selection ? previous.history : null,
        error: previous.selection === selection ? previous.error : null,
        isLoading: true,
      }))

      try {
        const nextHistory = await getAccessPointHistory(
          selection.apId,
          selection.window,
          controller.signal,
        )
        if (!ownsRequest()) return
        if (nextHistory.apId !== selection.apId || nextHistory.window !== selection.window) {
          // Reject mismatched content using the existing refresh-failure indicator.
          throw new Error()
        }
        setState({ selection, history: nextHistory, error: null, isLoading: true })
      } catch (requestError) {
        if (ownsRequest()) {
          setState((previous) => ({
            ...previous,
            error: requestError instanceof Error ? requestError.message : '',
          }))
        }
      } finally {
        if (ownsRequest()) {
          currentRequest = null
          setState((previous) => ({ ...previous, isLoading: false }))
        }
      }
    }

    const initialLoadId = window.setTimeout(() => void loadHistory(), 0)
    const pollId = window.setInterval(() => void loadHistory(), 5_000)

    return () => {
      active = false
      currentRequest?.abort()
      window.clearTimeout(initialLoadId)
      window.clearInterval(pollId)
    }
  }, [selection])

  const summary = useMemo(() => summarizeHistory(history), [history])
  const timeline = useMemo(() => buildTimeline(history), [history])
  const recentSamples = history?.samples.slice(-12).reverse() ?? []

  return (
    <section className="section-block history-section" aria-labelledby="history-heading">
      <div className="section-heading history-heading-row">
        <div>
          <p className="section-kicker">Prometheus range query</p>
          <h2 id="history-heading">Access point history</h2>
        </div>
        <div className="history-controls">
          <label>
            <span>Access point</span>
            <select
              value={selectedApId}
              onChange={(event) => {
                const apId = event.target.value
                setSelection((previous) => previous.apId === apId ? previous : { ...previous, apId })
              }}
            >
              {accessPoints.map((accessPoint) => (
                <option value={accessPoint.apId} key={accessPoint.apId}>
                  {accessPoint.apId} · {formatName(accessPoint.zone)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Time window</span>
            <select
              value={historyWindow}
              onChange={(event) => {
                const window = event.target.value as HistoryWindow
                setSelection((previous) => previous.window === window ? previous : { ...previous, window })
              }}
            >
              {historyWindows.map((historyWindow) => (
                <option value={historyWindow.value} key={historyWindow.value}>
                  {historyWindow.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error !== null && (
        <div className="error-banner" role="alert">
          <strong>History refresh failed.</strong> {error}
          {history && ' Showing the most recent successful range response.'}
        </div>
      )}

      {!history && isLoading ? (
        <p className="loading-message" role="status">
          Loading timestamped samples…
        </p>
      ) : null}

      {history && summary && timeline ? (
        <div className="history-panel" aria-busy={isLoading}>
          <div className="history-summary" aria-label="History summary">
            <SummaryItem label="Samples" value={String(history.samples.length)} />
            <SummaryItem label="State changes" value={String(summary.stateChanges)} />
            <SummaryItem label="Offline samples" value={String(summary.offlineSamples)} />
            <SummaryItem
              label="Latest clients"
              value={String(summary.latestClients)}
            />
          </div>

          <div className="timeline-block">
            <div className="timeline-heading">
              <strong>Operational timeline</strong>
              <span>
                {formatDateTime(history.startUtc)} – {formatDateTime(history.endUtc)} ·{' '}
                {history.stepSeconds}s resolution
              </span>
            </div>
            <div
              className="state-timeline"
              role="img"
              aria-label={`Requested window: ${history.startUtc} to ${history.endUtc}. ${history.stepSeconds}s resolution. ${summary.offlineSamples} of ${history.samples.length} samples were offline. Leading gap: ${timeline.hasLeadingGap ? 'yes' : 'no'}. Internal gaps: ${timeline.hasInternalGaps ? 'yes' : 'no'}. Trailing gap: ${timeline.hasTrailingGap ? 'yes' : 'no'}.`}
              aria-describedby="history-timeline-explanation"
            >
              {timeline.cells.map(({ sample, left, width }) => (
                <span
                  className={!sample.operational ? 'timeline-down' : sample.degraded ? 'timeline-degraded' : 'timeline-up'}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${formatDateTime(sample.observedAtUtc)} — ${historyStatus(sample)}`}
                  key={sample.observedAtUtc}
                />
              ))}
            </div>
            <div className="timeline-legend" aria-hidden="true">
              <span><i className="legend-up" /> Healthy</span>
              <span><i className="legend-degraded" /> Degraded</span>
              <span><i className="legend-down" /> Offline</span>
              <span><i className="legend-unobserved" /> Not observed</span>
            </div>
            <p className="timeline-explanation" id="history-timeline-explanation">
              Cell width represents query resolution, not measured state duration. Empty areas were not observed. State changes compare adjacent samples.
              {' '}Quality changes do not count as operational state changes.
            </p>
          </div>

          <div className="recent-history">
            <div className="timeline-heading">
              <strong>Most recent samples</strong>
              <span>Newest first · source: {history.source}</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Observed</th>
                    <th scope="col">Status</th>
                    <th scope="col">Clients</th>
                    <th scope="col">Channel use</th>
                    <th scope="col">Mgmt latency</th>
                    <th scope="col">Packet loss</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSamples.map((sample) => (
                    <HistoryRow sample={sample} key={sample.observedAtUtc} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function HistoryRow({ sample }: { sample: AccessPointHistorySample }) {
  return (
    <tr className={sample.operational ? undefined : 'offline-row'}>
      <th scope="row">{formatTime(sample.observedAtUtc)}</th>
      <td>{historyStatus(sample)}</td>
      <td>{sample.clients}</td>
      <td>{formatOptionalRatio(sample.channelUtilizationRatio)}</td>
      <td>{formatOptionalMilliseconds(sample.managementLatencySeconds)}</td>
      <td>{formatOptionalRatio(sample.managementPacketLossRatio)}</td>
    </tr>
  )
}

function historyStatus(sample: AccessPointHistorySample) {
  return !sample.operational ? 'Offline' : sample.degraded ? 'Degraded' : 'Healthy'
}

function summarizeHistory(history: AccessPointHistory | null) {
  if (!history || history.samples.length === 0) {
    return null
  }

  let stateChanges = 0
  for (let index = 1; index < history.samples.length; index += 1) {
    if (areAdjacent(history.samples[index - 1], history.samples[index], history.stepSeconds)
      && history.samples[index].operational !== history.samples[index - 1].operational) {
      stateChanges += 1
    }
  }

  return {
    stateChanges,
    offlineSamples: history.samples.filter((sample) => !sample.operational).length,
    latestClients: history.samples.at(-1)?.clients ?? 0,
  }
}

function areAdjacent(
  previous: AccessPointHistorySample,
  current: AccessPointHistorySample,
  stepSeconds: number,
) {
  const elapsed = Date.parse(current.observedAtUtc) - Date.parse(previous.observedAtUtc)
  // The API rounds timestamps to milliseconds; this is only a precision allowance.
  return typeof previous.operational === 'boolean'
    && typeof current.operational === 'boolean'
    && elapsed > 0
    && Math.abs(elapsed - stepSeconds * 1000) <= 1
}

function buildTimeline(history: AccessPointHistory | null) {
  if (!history || history.samples.length === 0) return null

  const start = Date.parse(history.startUtc)
  const end = Date.parse(history.endUtc)
  const duration = end - start
  const halfStep = history.stepSeconds * 1000 / 2
  const cells = history.samples.map((sample) => {
    const timestamp = Date.parse(sample.observedAtUtc)
    return { sample, timestamp, start: timestamp - halfStep, end: timestamp + halfStep }
  })

  let hasInternalGaps = false
  for (let index = 1; index < cells.length; index += 1) {
    const previous = cells[index - 1]
    const current = cells[index]
    if (areAdjacent(previous.sample, current.sample, history.stepSeconds)) {
      const midpoint = (previous.timestamp + current.timestamp) / 2
      previous.end = midpoint
      current.start = midpoint
    } else {
      hasInternalGaps = true
      // Keep gap-facing edges separate, including intervals just shorter than a step.
      const gapStart = Math.min(previous.end, current.start)
      const gapEnd = Math.max(previous.end, current.start)
      previous.end = gapStart
      current.start = gapEnd
    }
  }

  return {
    hasLeadingGap: cells[0].start > start,
    hasInternalGaps,
    hasTrailingGap: cells[cells.length - 1].end < end,
    cells: cells.map((cell) => {
      const cellStart = Math.max(start, Math.min(end, cell.start))
      const cellEnd = Math.max(start, Math.min(end, cell.end))
      return {
        sample: cell.sample,
        left: (cellStart - start) / duration * 100,
        width: Math.max(0, cellEnd - cellStart) / duration * 100,
      }
    }),
  }
}

function formatName(value: string) {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatOptionalRatio(value: number | null) {
  return value === null ? 'Not observed' : `${(value * 100).toFixed(1)}%`
}

function formatOptionalMilliseconds(value: number | null) {
  return value === null ? 'Not observed' : `${(value * 1_000).toFixed(1)} ms`
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
