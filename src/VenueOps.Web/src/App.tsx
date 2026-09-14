import { useEffect, useRef, useState } from 'react'
import {
  getOperationsOverview,
  type AccessPointObservation,
  type OperationsOverview,
} from './api/operations'
import { AccessPointHistoryPanel } from './components/AccessPointHistoryPanel'
import { IncidentCreatePanel } from './components/IncidentCreatePanel'
import { IncidentListPanel } from './components/IncidentListPanel'
import { IncidentDetailPanel } from './components/IncidentDetailPanel'
import { incidentUrl, interceptNavigation, listenIncidentNavigation, navigateIncident, parseIncidentLocation, type IncidentLocation } from './incidentNavigation'
import { creationKey, defaultIncidentTitle, readAttempt, scopeFromAccessPoints, type CreationDraft, type IncidentDraft } from './incidentRequestState'
import type { IncidentFilters } from './api/incidents'
import './App.css'

function App() {
  const [overview, setOverview] = useState<OperationsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const refreshRef = useRef<(() => Promise<void>) | null>(null)

  const [route, setRoute] = useState(() => ({...parseIncidentLocation(), generation: 0}))
  const [filters, setFilters] = useState<IncidentFilters>({status: route.status, zone: route.zone})
  const [drafts] = useState(() => new Map<number, IncidentDraft>())
  const [createDraft, setCreateDraft] = useState<CreationDraft | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createGeneration, setCreateGeneration] = useState(0)
  const [scopeError, setScopeError] = useState<string | null>(null)
  const createOrigin = useRef<HTMLElement | null>(null)
  const savedCreate = readAttempt(creationKey)

  useEffect(() => listenIncidentNavigation(() => {
    const next = parseIncidentLocation()
    if (next.view === 'incidents') setFilters({status: next.status, zone: next.zone})
    setCreateOpen(false)
    setRoute(previous => ({...next, generation: previous.generation + 1}))
  }), [])

  function openCreate(entryPoint: 'ap' | 'zone', target: string, origin: HTMLElement) {
    const saved = readAttempt(creationKey)
    createOrigin.current = origin
    if (!saved.attempt && !saved.error && overview && !error) {
      const scope = scopeFromAccessPoints(overview.accessPoints, entryPoint, target)
      if (!scope) return
      // Preserve an unsent draft when reopening exactly the same frozen scope.
      if (!createDraft || JSON.stringify(createDraft.scope) !== JSON.stringify(scope))
        setCreateDraft({scope, title: defaultIncidentTitle(scope), responderLabel: ''})
    }
    setScopeError(null); setCreateGeneration(n => n + 1); setCreateOpen(true)
  }
  function startCurrentScope() {
    const previous = createDraft?.scope ?? (savedCreate.attempt?.kind === 'create' ? savedCreate.attempt.scope : null)
    const scope = previous && overview && !error ? scopeFromAccessPoints(overview.accessPoints, previous.entryPoint, previous.target) : null
    if (!scope) { setScopeError('The selected condition has recovered or monitoring is unavailable. Cancel and review monitoring.'); return }
    setCreateDraft({scope, title: createDraft?.title ?? (savedCreate.attempt?.kind === 'create' ? savedCreate.attempt.payload.title : defaultIncidentTitle(scope)), responderLabel: createDraft?.responderLabel ?? ''})
    setScopeError(null); setCreateGeneration(n => n + 1)
  }
  const listRoute: IncidentLocation = {view: 'incidents', invalidIncident: false, ...filters}
  const monitoringRoute: IncidentLocation = {view: 'monitoring', invalidIncident: false}

  useEffect(() => {
    let active = true
    let currentRequest: AbortController | null = null

    const refresh = async () => {
      // Manual refresh and polling share this synchronous guard.
      if (!active || currentRequest) return
      const controller = new AbortController()
      currentRequest = controller
      const ownsRequest = () => active && currentRequest === controller
      setIsLoading(true)

      try {
        const nextOverview = await getOperationsOverview(controller.signal)
        if (ownsRequest()) {
          setOverview(nextOverview)
          setError(null)
        }
      } catch (requestError) {
        if (ownsRequest()) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'The operations overview could not be loaded.',
          )
        }
      } finally {
        if (ownsRequest()) {
          currentRequest = null
          setIsLoading(false)
        }
      }
    }

    refreshRef.current = refresh
    const initialLoadId = window.setTimeout(() => void refresh(), 0)
    const pollId = window.setInterval(() => void refresh(), 5_000)

    return () => {
      // Invalidate first: an aborted request may still settle after cleanup.
      active = false
      currentRequest?.abort()
      refreshRef.current = null
      window.clearTimeout(initialLoadId)
      window.clearInterval(pollId)
    }
  }, [])

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Monitoring · Incident response</p>
          <h1>Venue Network Operations Console</h1>
          <p className="page-description">
            Monitor synthetic venue telemetry, investigate network conditions, and track incident response.
          </p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void refreshRef.current?.()}
          disabled={isLoading}
        >
          {isLoading ? 'Refreshing monitoring…' : 'Refresh monitoring'}
        </button>
      </header>

      <nav className="app-navigation" aria-label="Main navigation">
        {[{label: 'Monitoring', location: monitoringRoute}, {label: 'Incidents', location: listRoute}].map(item => <a key={item.label} href={incidentUrl(item.location)} aria-current={route.view === item.location.view ? 'page' : undefined} onClick={event => interceptNavigation(event, () => navigateIncident(item.location))}>{item.label}</a>)}
      </nav>
      {!createOpen && (savedCreate.attempt || savedCreate.error || createDraft) && <div className="incident-notice"><button type="button" onClick={event => {createOrigin.current = event.currentTarget; setCreateGeneration(n => n + 1); setCreateOpen(true)}}>{savedCreate.attempt || savedCreate.error ? 'Review saved create attempt' : 'Continue incident draft'}</button></div>}
      {scopeError && <p role="alert" className="error-banner">{scopeError}</p>}
      {createOpen && <IncidentCreatePanel key={createGeneration} draft={createDraft} onDraftChange={setCreateDraft} canCreate={!!overview && !error && overview.simulatorScrape.up && !scopeError} onConditionChanged={() => void refreshRef.current?.()} onStartCurrent={startCurrentScope} onClose={() => {setCreateOpen(false); setScopeError(null); createOrigin.current?.focus()}} onCreated={incident => {setCreateDraft(null); setCreateOpen(false); navigateIncident({...listRoute, incidentId: incident.id})}} />}
      {route.view === 'incidents' && <>
        {(route.incidentId || route.invalidIncident) && <a className="incident-back" href={incidentUrl(listRoute)} onClick={event => interceptNavigation(event, () => navigateIncident(listRoute))}>Back to incidents</a>}
        {route.invalidIncident ? <section className="section-block incident-panel"><h2 tabIndex={-1} ref={element => element?.focus()}>Invalid incident link</h2><p>Incident IDs must be positive supported integers.</p></section> : route.incidentId ? <IncidentDetailPanel key={route.generation} incidentId={route.incidentId} overview={overview} overviewError={error} isOverviewLoading={isLoading} drafts={drafts} /> : <IncidentListPanel key={route.generation} filters={{status: route.status, zone: route.zone}} onFiltersChange={next => navigateIncident({view:'incidents', invalidIncident:false, ...next}, true)} onOpen={incidentId => navigateIncident({...listRoute, incidentId})} />}
      </>}

      {route.view === 'monitoring' && error !== null && (
        <div className="error-banner" role="alert">
          <strong>Telemetry refresh failed.</strong> {error}
          {overview && ' Showing the most recent successful response.'}
        </div>
      )}

      {route.view === 'monitoring' && !overview && isLoading ? (
        <p className="loading-message" role="status">
          Loading the Prometheus-backed overview…
        </p>
      ) : null}

      {route.view === 'monitoring' && overview && (
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
                    <ZoneStatusBadge operationalRatio={zone.operationalRatio} degradedAccessPoints={zone.degradedAccessPoints} />
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
                    <div>
                      <dt>Degraded APs</dt>
                      <dd>{zone.degradedAccessPoints}</dd>
                    </div>
                  </dl>
                  {scopeFromAccessPoints(overview.accessPoints, 'zone', zone.zone) && <button type="button" className="incident-create-action" disabled={!!error || !overview.simulatorScrape.up} onClick={event => openCreate('zone', zone.zone, event.currentTarget)}>Create incident</button>}
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
                    <th scope="col">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.accessPoints.map((accessPoint) => (
                    <AccessPointRow
                      accessPoint={accessPoint}
                      key={accessPoint.apId}
                      canCreate={!error && overview.simulatorScrape.up}
                      onCreate={origin => openCreate('ap', accessPoint.apId, origin)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <AccessPointHistoryPanel accessPoints={overview.accessPoints} />

          <footer className="provenance-note">
            <strong>Source key:</strong> AP and RF values are simulated; zone
            client/availability summaries are derived by Prometheus; quality is
            derived by the API; scrape and HTTP probe results
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
  accessPoint, canCreate, onCreate,
}: {
  accessPoint: AccessPointObservation
  canCreate: boolean
  onCreate: (origin: HTMLElement) => void
}) {
  return (
    <tr className={accessPoint.operational ? undefined : 'offline-row'}>
      <th scope="row">{accessPoint.apId}</th>
      <td>{formatName(accessPoint.zone)}</td>
      <td>
        <StatusBadge operational={accessPoint.operational} degraded={accessPoint.degraded} />
      </td>
      <td>{accessPoint.clients}</td>
      <td>{formatOptionalRatio(accessPoint.channelUtilizationRatio)}</td>
      <td>{formatOptionalMilliseconds(accessPoint.managementLatencySeconds)}</td>
      <td>{formatOptionalRatio(accessPoint.managementPacketLossRatio)}</td>
      <td>
        <div className="alert-item">
          <span className="alert-label">AP down</span>
          <span className={`alert-state alert-${accessPoint.alertState}`}>
            {accessPoint.alertState}
          </span>
        </div>
        <div className="alert-item">
          <span className="alert-label">Degradation</span>
          <span className={`alert-state alert-degradation alert-${accessPoint.degradationAlertState}`}>
            {accessPoint.degradationAlertState}
          </span>
        </div>
      </td>
      <td>{(!accessPoint.operational || accessPoint.degraded) && <button type="button" className="incident-create-action" disabled={!canCreate} onClick={event => onCreate(event.currentTarget)}>Create incident</button>}</td>
    </tr>
  )
}

function ZoneStatusBadge({ operationalRatio, degradedAccessPoints }: { operationalRatio: number; degradedAccessPoints: number }) {
  if (operationalRatio > 0 && operationalRatio < 1) {
    return <span className="status-badge status-offline">Partial outage</span>
  }
  return <StatusBadge operational={operationalRatio === 1} degraded={degradedAccessPoints > 0} />
}

function StatusBadge({ operational, degraded }: { operational: boolean; degraded: boolean }) {
  const status = !operational ? 'offline' : degraded ? 'degraded' : 'healthy'
  return (
    <span className={`status-badge status-${status}`}>
      {!operational ? 'Offline' : degraded ? 'Degraded' : 'Healthy'}
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
