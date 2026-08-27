import { useCallback, useEffect, useState } from 'react'
import {
  getOperationsOverview,
  type AccessPointObservation,
  type OperationsOverview,
} from './api/operations'
import './App.css'

function App() {
  const [overview, setOverview] = useState<OperationsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    setIsLoading(true)

    try {
      const nextOverview = await getOperationsOverview()
      setOverview(nextOverview)
      setError(null)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'The operations overview could not be loaded.',
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialLoadId = window.setTimeout(() => void refresh(), 0)
    const pollId = window.setInterval(() => void refresh(), 5_000)

    return () => {
      window.clearTimeout(initialLoadId)
      window.clearInterval(pollId)
    }
  }, [refresh])

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Milestone 2 · Operations overview</p>
          <h1>Venue Network Operations Console</h1>
          <p className="page-description">
            A minimal view of Prometheus-backed access point and zone telemetry.
          </p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void refresh()}
          disabled={isLoading}
        >
          {isLoading ? 'Refreshing…' : 'Refresh now'}
        </button>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <strong>Telemetry refresh failed.</strong> {error}
          {overview && ' Showing the most recent successful response.'}
        </div>
      )}

      {!overview && isLoading ? (
        <p className="loading-message" role="status">
          Loading the Prometheus-backed overview…
        </p>
      ) : null}

      {overview && (
        <>
          <section className="health-strip" aria-label="Monitoring path status">
            <HealthItem
              label="Simulator scrape"
              healthy={overview.simulatorScrape.up}
              detail={overview.simulatorScrape.source}
            />
            <HealthItem
              label="API HTTP probe"
              healthy={overview.probe.success}
              detail={`HTTP ${overview.probe.httpStatusCode} · ${formatMilliseconds(overview.probe.durationSeconds)}`}
            />
            <div className="health-item">
              <span className="health-label">Response generated</span>
              <strong>{formatTimestamp(overview.generatedAtUtc)}</strong>
              <span>Polls every 5 seconds</span>
            </div>
          </section>

          <section className="section-block" aria-labelledby="zones-heading">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Derived telemetry</p>
                <h2 id="zones-heading">Venue zones</h2>
              </div>
              <span>{overview.zones.length} zones</span>
            </div>
            <div className="zone-grid">
              {overview.zones.map((zone) => (
                <article className="zone-card" key={zone.zone}>
                  <div className="zone-card-heading">
                    <h3>{formatName(zone.zone)}</h3>
                    <StatusBadge healthy={zone.operationalRatio === 1} />
                  </div>
                  <dl>
                    <div>
                      <dt>Operational APs</dt>
                      <dd>{formatPercent(zone.operationalRatio)}</dd>
                    </div>
                    <div>
                      <dt>Associated clients</dt>
                      <dd>{zone.clients}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <section className="section-block" aria-labelledby="aps-heading">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Simulated controller telemetry</p>
                <h2 id="aps-heading">Access points</h2>
              </div>
              <span>{overview.accessPoints.length} access points</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Access point</th>
                    <th scope="col">Zone</th>
                    <th scope="col">Status</th>
                    <th scope="col">Clients</th>
                    <th scope="col">Channel use</th>
                    <th scope="col">Mgmt latency</th>
                    <th scope="col">Packet loss</th>
                    <th scope="col">Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.accessPoints.map((accessPoint) => (
                    <AccessPointRow
                      accessPoint={accessPoint}
                      key={accessPoint.apId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="provenance-note">
            <strong>Source key:</strong> AP and RF values are simulated; zone
            summaries are derived by Prometheus; scrape and HTTP probe results
            are measured locally.
          </footer>
        </>
      )}
    </main>
  )
}

function HealthItem({
  label,
  healthy,
  detail,
}: {
  label: string
  healthy: boolean
  detail: string
}) {
  return (
    <div className="health-item">
      <span className="health-label">{label}</span>
      <strong className={healthy ? 'status-good' : 'status-bad'}>
        <span className="status-dot" aria-hidden="true" />
        {healthy ? 'Healthy' : 'Unavailable'}
      </strong>
      <span>{detail}</span>
    </div>
  )
}

function AccessPointRow({
  accessPoint,
}: {
  accessPoint: AccessPointObservation
}) {
  return (
    <tr className={accessPoint.operational ? undefined : 'offline-row'}>
      <th scope="row">{accessPoint.apId}</th>
      <td>{formatName(accessPoint.zone)}</td>
      <td>
        <StatusBadge healthy={accessPoint.operational} />
      </td>
      <td>{accessPoint.clients}</td>
      <td>{formatOptionalRatio(accessPoint.channelUtilizationRatio)}</td>
      <td>{formatOptionalMilliseconds(accessPoint.managementLatencySeconds)}</td>
      <td>{formatOptionalRatio(accessPoint.managementPacketLossRatio)}</td>
      <td>
        <span className={`alert-state alert-${accessPoint.alertState}`}>
          {accessPoint.alertState}
        </span>
      </td>
    </tr>
  )
}

function StatusBadge({ healthy }: { healthy: boolean }) {
  return (
    <span className={`status-badge ${healthy ? 'status-healthy' : 'status-offline'}`}>
      {healthy ? 'Operational' : 'Offline'}
    </span>
  )
}

function formatName(value: string) {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(value === 1 || value === 0 ? 0 : 1)}%`
}

function formatOptionalRatio(value: number | null) {
  return value === null ? 'Not observed' : formatPercent(value)
}

function formatMilliseconds(seconds: number) {
  return `${(seconds * 1_000).toFixed(1)} ms`
}

function formatOptionalMilliseconds(value: number | null) {
  return value === null ? 'Not observed' : formatMilliseconds(value)
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

export default App
