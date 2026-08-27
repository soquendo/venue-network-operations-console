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

export function AccessPointHistoryPanel({
  accessPoints,
}: {
  accessPoints: AccessPointObservation[]
}) {
  const [selectedApId, setSelectedApId] = useState(accessPoints[0]?.apId ?? '')
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>('15m')
  const [history, setHistory] = useState<AccessPointHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    const loadHistory = async () => {
      setIsLoading(true)
      try {
        const nextHistory = await getAccessPointHistory(
          selectedApId,
          historyWindow,
          controller.signal,
        )
        if (active) {
          setHistory(nextHistory)
          setError(null)
        }
      } catch (requestError) {
        if (active && requestError instanceof Error && requestError.name !== 'AbortError') {
          setError(requestError.message)
        }
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    const initialLoadId = window.setTimeout(() => void loadHistory(), 0)
    const pollId = window.setInterval(() => void loadHistory(), 5_000)

    return () => {
      active = false
      controller.abort()
      window.clearTimeout(initialLoadId)
      window.clearInterval(pollId)
    }
  }, [selectedApId, historyWindow])

  const summary = useMemo(() => summarizeHistory(history), [history])
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
              onChange={(event) => setSelectedApId(event.target.value)}
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
              onChange={(event) =>
                setHistoryWindow(event.target.value as HistoryWindow)
              }
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

      {error && (
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

      {history && summary ? (
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
              aria-label={`${summary.offlineSamples} of ${history.samples.length} samples were offline`}
            >
              {history.samples.map((sample) => (
                <span
                  className={sample.operational ? 'timeline-up' : 'timeline-down'}
                  title={`${formatDateTime(sample.observedAtUtc)} — ${sample.operational ? 'Operational' : 'Offline'}`}
                  key={sample.observedAtUtc}
                />
              ))}
            </div>
            <div className="timeline-legend" aria-hidden="true">
              <span><i className="legend-up" /> Operational</span>
              <span><i className="legend-down" /> Offline</span>
            </div>
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
      <td>{sample.operational ? 'Operational' : 'Offline'}</td>
      <td>{sample.clients}</td>
      <td>{formatOptionalRatio(sample.channelUtilizationRatio)}</td>
      <td>{formatOptionalMilliseconds(sample.managementLatencySeconds)}</td>
      <td>{formatOptionalRatio(sample.managementPacketLossRatio)}</td>
    </tr>
  )
}

function summarizeHistory(history: AccessPointHistory | null) {
  if (!history || history.samples.length === 0) {
    return null
  }

  let stateChanges = 0
  for (let index = 1; index < history.samples.length; index += 1) {
    if (history.samples[index].operational !== history.samples[index - 1].operational) {
      stateChanges += 1
    }
  }

  return {
    stateChanges,
    offlineSamples: history.samples.filter((sample) => !sample.operational).length,
    latestClients: history.samples.at(-1)?.clients ?? 0,
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
