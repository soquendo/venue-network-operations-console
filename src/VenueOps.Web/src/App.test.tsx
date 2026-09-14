// @vitest-environment jsdom
import { act, Activity, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { advanceTime, clickButton, controlFetch, deferred, makeHistory, makeIncident, makeIncidentSummary, makeOverview, render, selectValue, setupDomTests } from './testUtils'
import type { OperationsOverview } from './api/operations'

setupDomTests()

describe('held event quality presentation', () => {
  it('shows degraded operational APs and zones, healthy unaffected zones, and separate alerts', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const overview = makeOverview()
    Object.assign(overview.accessPoints[0], { degraded: true, degradationAlertState: 'pending' })
    Object.assign(overview.accessPoints[1], { degraded: true, degradationAlertState: 'firing' })
    Object.assign(overview.zones[0], { degradedAccessPoints: 2 })
    await fetch.overview()[0].json(overview)
    const rows = view.container.querySelectorAll('[aria-labelledby="aps-heading"] tbody tr')
    expect(rows[0].querySelector('.status-badge')?.textContent).toBe('Degraded')
    expect(rows[1].querySelector('.status-badge')?.textContent).toBe('Degraded')
    expect(rows[2].querySelector('.status-badge')?.textContent).toBe('Healthy')
    expect(rows[0].textContent).toContain('AP down')
    expect(rows[0].textContent).toContain('Degradation')
    expect(rows[0].querySelector('.alert-pending')?.textContent).toBe('pending')
    expect(rows[1].querySelector('.alert-degradation.alert-firing')).not.toBeNull()
    const zones = view.container.querySelectorAll('.zone-card')
    expect(zones[0].querySelector('.status-badge')?.textContent).toBe('Degraded')
    expect(zones[0].textContent).toContain('Degraded APs2')
    expect(zones[1].querySelector('.status-badge')?.textContent).toBe('Healthy')
  })

  it('gives availability loss precedence over degraded flags for APs and zones', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const overview = makeOverview()
    Object.assign(overview.accessPoints[0], { operational: false, degraded: true, alertState: 'firing' })
    Object.assign(overview.zones[0], { operationalRatio: 0.5, degradedAccessPoints: 1 })
    await fetch.overview()[0].json(overview)
    expect(view.container.querySelector('[aria-labelledby="aps-heading"] .status-badge')?.textContent).toBe('Offline')
    expect(view.container.querySelector('.zone-card .status-badge')?.textContent).toBe('Partial outage')
  })

  it('retains degraded data with a refresh error and replaces it with healthy recovery', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const peak = makeOverview()
    Object.assign(peak.accessPoints[0], { degraded: true, degradationAlertState: 'firing' })
    Object.assign(peak.zones[0], { degradedAccessPoints: 1 })
    await fetch.overview()[0].json(peak)
    await advanceTime(5_000)
    await fetch.overview()[1].reject(new Error('refresh unavailable'))
    expect(view.container.querySelector('.error-banner')?.textContent).toContain('refresh unavailable')
    expect(view.container.querySelector('[aria-labelledby="aps-heading"] .status-badge')?.textContent).toBe('Degraded')
    await advanceTime(5_000)
    await fetch.overview()[2].json(makeOverview())
    expect(view.container.querySelector('.error-banner')).toBeNull()
    expect(view.container.querySelector('[aria-labelledby="aps-heading"] .status-badge')?.textContent).toBe('Healthy')
    expect(view.container.querySelector('.zone-card .status-badge')?.textContent).toBe('Healthy')
    expect(view.container.querySelector('.alert-degradation.alert-firing')).toBeNull()
  })
})

describe('zone availability semantics', () => {
  it.each([
    { ratio: 1, degraded: 0, label: 'Healthy', percentage: '100%' },
    { ratio: 1, degraded: 1, label: 'Degraded', percentage: '100%' },
    { ratio: 0.5, degraded: 0, label: 'Partial outage', percentage: '50.0%' },
    { ratio: 0.5, degraded: 1, label: 'Partial outage', percentage: '50.0%' },
    { ratio: 0, degraded: 0, label: 'Offline', percentage: '0%' },
  ])('shows $label at ratio $ratio with $degraded degraded APs', async ({ ratio, degraded, label, percentage }) => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const overview = makeOverview()
    Object.assign(overview.zones[0], { operationalRatio: ratio, degradedAccessPoints: degraded })
    // The zone badge must use the supplied zone aggregate, not recalculate from AP rows.
    await fetch.overview()[0].json(overview)
    const zone = view.container.querySelector('.zone-card')!
    expect(zone.querySelector('h3')?.textContent).toBe('Zone A')
    expect(zone.querySelector('.status-badge')?.textContent).toBe(label)
    const facts = Object.fromEntries([...zone.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent]))
    expect(facts).toEqual({ 'Operational APs': percentage, 'Associated clients': '77', 'Degraded APs': String(degraded) })
    if (ratio < 1) expect(zone.querySelector('.status-offline')).not.toBeNull()
  })

  it.each([
    { condition: 'partial outage', survivor: 'healthy', expected: [{ apId: 'ap-001', expectedCondition: 'offline' }] },
    { condition: 'mixed condition', survivor: 'degraded', expected: [{ apId: 'ap-001', expectedCondition: 'offline' }, { apId: 'ap-002', expectedCondition: 'degraded' }] },
    { condition: 'fully offline', survivor: 'offline', expected: [{ apId: 'ap-001', expectedCondition: 'offline' }, { apId: 'ap-002', expectedCondition: 'offline' }] },
  ])('preserves zone creation payload for $condition', async ({ survivor, expected }) => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const overview = makeOverview()
    Object.assign(overview.accessPoints[0], { operational: false, clients: 0, channelUtilizationRatio: null, managementLatencySeconds: null, managementPacketLossRatio: null })
    if (survivor === 'offline') Object.assign(overview.accessPoints[1], { operational: false, clients: 0, channelUtilizationRatio: null, managementLatencySeconds: null, managementPacketLossRatio: null })
    if (survivor === 'degraded') overview.accessPoints[1].degraded = true
    Object.assign(overview.zones[0], { operationalRatio: survivor === 'offline' ? 0 : 0.5, degradedAccessPoints: survivor === 'degraded' ? 1 : 0 })
    await fetch.overview()[0].json(overview)
    const rows = view.container.querySelectorAll('[aria-labelledby="aps-heading"] tbody tr')
    expect(rows[0].querySelector('.status-badge')?.textContent).toBe('Offline')
    expect(rows[1].querySelector('.status-badge')?.textContent).toBe(survivor === 'offline' ? 'Offline' : survivor === 'degraded' ? 'Degraded' : 'Healthy')
    await act(async () => view.container.querySelector<HTMLButtonElement>('.zone-card button')!.click())
    await clickButton(view.container.querySelector<HTMLElement>('[aria-labelledby="create-incident-heading"]')!, 'Create incident')
    const posts = fetch.requests.filter(request => request.options?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('/api/incidents')
    const payload = JSON.parse(String(posts[0].options?.body))
    expect(payload.accessPoints).toEqual(expected)
    expect(Object.keys(payload).sort()).toEqual(['accessPoints', 'creationCommandId', 'responderLabel', 'title'])
    expect(payload.responderLabel).toBeNull()
    expect(payload.title).toBe(expected.length === 1 ? 'ap-001 offline' : 'Zone A network condition')
    expect(payload.creationCommandId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('visible refresh ownership', () => {
  it.each(['list', 'detail'] as const)('keeps monitoring and stored %s refreshes separate', async route => {
    const path = route === 'list' ? '/api/incidents?status=Open&zone=zone-a' : '/api/incidents/5'
    window.history.replaceState(null, '', route === 'list' ? '/?view=incidents&status=Open&zone=zone-a' : '/?view=incidents&incident=5')
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    await fetch.overview()[0].json(makeOverview())
    const storedRequests = () => fetch.requests.filter(request => request.url === path)
    const initial = makeIncident()
    await storedRequests()[0].json(route === 'list' ? { items: [makeIncidentSummary()], hasMore: false, nextBeforeId: null } : initial)
    const localLabel = route === 'list' ? 'Refresh incidents' : 'Refresh incident'
    const labels = () => [...view.container.querySelectorAll('button')].map(button => button.textContent)
    expect.soft(labels()).toContain('Refresh monitoring')
    expect(labels()).toContain(localLabel)
    const evidence = () => view.container.querySelector('[aria-labelledby="captured-heading"]')?.textContent
    const captured = evidence()
    const beforeMonitoring = fetch.requests.length
    // Target the existing shell control so pre-fix ownership assertions still execute.
    const shell = view.container.querySelector<HTMLButtonElement>('.refresh-button')!
    await act(async () => shell.click())
    expect.soft(shell.textContent).toBe('Refreshing monitoring…')
    expect(shell.disabled).toBe(true)
    expect(fetch.requests.slice(beforeMonitoring).map(request => request.url)).toEqual(['/api/operations/overview'])
    await fetch.overview()[1].json(makeOverview(99))
    expect.soft(shell.textContent).toBe('Refresh monitoring')
    expect(shell.disabled).toBe(false)
    expect(storedRequests()).toHaveLength(1)
    if (route === 'detail') {
      expect(view.container.querySelector('[data-incident-version]')?.getAttribute('data-incident-version')).toBe('1')
      expect(evidence()).toBe(captured)
      expect(view.container.querySelector('[aria-labelledby="current-network-heading"]')?.textContent).toContain('Clients99')
    }
    const beforeLocal = fetch.requests.length
    await clickButton(view.container, localLabel)
    expect(fetch.requests.slice(beforeLocal).map(request => request.url)).toEqual([path])
    if (route === 'list') {
      await storedRequests()[1].json({ items: [{ ...makeIncidentSummary(), responderLabel: 'Network Operations', version: 2 }], hasMore: false, nextBeforeId: null })
      expect(view.container.querySelector('.incident-list')?.textContent).toContain('Network Operations')
    } else {
      await storedRequests()[1].json({ ...makeIncident(5, 2, 'Investigating'), monitoringEvidence: initial.monitoringEvidence })
      expect(view.container.querySelector('[data-incident-version]')?.getAttribute('data-incident-version')).toBe('2')
      expect(view.container.querySelector('[aria-labelledby="response-state-heading"]')?.textContent).toContain('Investigating')
      expect(evidence()).toBe(captured)
      expect(view.container.querySelector('[aria-labelledby="current-network-heading"]')?.textContent).toContain('Clients99')
    }
    expect(fetch.overview()).toHaveLength(2)
    expect(fetch.history()).toHaveLength(0)
    expect(fetch.requests.filter(request => request.url.startsWith('/api/incidents')).map(request => request.url)).toEqual([path, path])
    // No clock advancement occurred during clicks; the existing sole poller remains scheduled.
    expect(vi.getTimerCount()).toBe(1)
    await advanceTime(5_000)
    expect(fetch.overview()).toHaveLength(3)
    expect(storedRequests()).toHaveLength(2)
  })
})

function firstClientCount(container: HTMLElement) {
  return container.querySelector('[aria-labelledby="aps-heading"] tbody td:nth-child(4)')?.textContent
}

describe('overview request ownership', () => {
  it('skips busy polling ticks without aborting or queuing the slow request', async () => {
    const fetch = controlFetch()
    await render(<App />)
    await advanceTime(0)
    await advanceTime(15_000)
    expect(fetch.overview()).toHaveLength(1)
    expect(fetch.overview()[0].signal?.aborted).toBe(false)
    await fetch.overview()[0].json(makeOverview())
    await advanceTime(4_999)
    expect(fetch.overview()).toHaveLength(1)
    await advanceTime(1)
    expect(fetch.overview()).toHaveLength(2)
    expect(fetch.overview()[1].signal).not.toBe(fetch.overview()[0].signal)
  })

  it.each(['manual first', 'poll first'])('uses one guard for manual refresh and polling: %s', async (order) => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    await fetch.overview()[0].json(makeOverview())
    await advanceTime(4_999)
    const button = view.container.querySelector('button')!
    if (order === 'poll first') await advanceTime(1)
    await act(async () => {
      button.click()
      button.click()
    })
    if (order === 'manual first') await advanceTime(1)
    expect(fetch.overview()).toHaveLength(2)
    expect(button.disabled).toBe(true)
  })

  it('holds the guard until the overview response body has resolved', async () => {
    const fetch = controlFetch()
    await render(<App />)
    await advanceTime(0)
    const body = deferred<OperationsOverview>()
    const response = new Response('{}')
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    await fetch.overview()[0].respond(response)
    await advanceTime(10_000)
    expect(fetch.overview()).toHaveLength(1)
    await act(async () => body.resolve(makeOverview()))
    await advanceTime(5_000)
    expect(fetch.overview()).toHaveLength(2)
  })

  it('retains previous data and the failure until a successful refresh recovers', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    await fetch.overview()[0].json(makeOverview())
    await advanceTime(5_000)
    await fetch.overview()[1].json({ detail: 'Overview unavailable' }, 503)
    expect(firstClientCount(view.container)).toBe('42')
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Showing the most recent successful response.')
    await act(async () => view.container.querySelector('button')!.click())
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Overview unavailable')
    await fetch.overview()[2].json(makeOverview(99))
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(firstClientCount(view.container)).toBe('99')
    expect(view.container.querySelector('button')?.disabled).toBe(false)
  })

  it('makes a current failure with an empty message explicit', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    await fetch.overview()[0].reject(new Error(''))
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Telemetry refresh failed.')
  })

  // Activity replays effect cleanup/setup while preserving component state, so late writes
  // cannot be hidden by React discarding state setters from a fully unmounted component.
  async function restartLifecycle() {
    const fetch = controlFetch()
    const view = await render(<Activity mode="visible"><App /></Activity>)
    await advanceTime(0)
    await view.rerender(<Activity mode="hidden"><App /></Activity>)
    await view.rerender(<Activity mode="visible"><App /></Activity>)
    await advanceTime(0)
    expect(fetch.overview()).toHaveLength(2)
    return { fetch, view }
  }

  it.each(['success', 'failure'])('rejects an older lifecycle %s after the current response succeeds', async (outcome) => {
    const { fetch, view } = await restartLifecycle()
    await fetch.overview()[1].json(makeOverview(99))
    if (outcome === 'success') await fetch.overview()[0].json(makeOverview(11))
    else await fetch.overview()[0].reject(new Error('Obsolete overview failure'))
    expect(firstClientCount(view.container)).toBe('99')
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not let an obsolete success clear the current refresh error', async () => {
    const { fetch, view } = await restartLifecycle()
    await fetch.overview()[1].reject(new Error('Current overview failure'))
    await fetch.overview()[0].json(makeOverview(11))
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Current overview failure')
    expect(firstClientCount(view.container)).toBeUndefined()
  })

  it.each(['success', 'failure'])('preserves current loading and guard when an older lifecycle settles with %s', async (outcome) => {
    const { fetch, view } = await restartLifecycle()
    if (outcome === 'success') await fetch.overview()[0].json(makeOverview(11))
    else await fetch.overview()[0].reject(new Error('Obsolete failure'))
    expect(view.container.querySelector('button')?.disabled).toBe(true)
    await advanceTime(10_000)
    expect(fetch.overview()).toHaveLength(2)
    expect(fetch.overview()[0].signal?.aborted).toBe(true)
    await fetch.overview()[1].json(makeOverview(99))
    expect(firstClientCount(view.container)).toBe('99')
    await advanceTime(5_000)
    expect(fetch.overview()).toHaveLength(3)
  })

  it('aborts pending work and clears timers on unmount even if fetch later resolves', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    await view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await fetch.overview()[0].json(makeOverview())
    await advanceTime(15_000)
    expect(fetch.overview()).toHaveLength(1)
    expect(document.body.childElementCount).toBe(0)
    expect(fetch.overview()[0].signal?.aborted).toBe(true)
  })

  it('clears the initial timer when unmounted before loading starts', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await view.unmount()
    await advanceTime(15_000)
    expect(fetch.requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves one initial polling lifecycle under Strict Mode', async () => {
    const fetch = controlFetch()
    await render(<StrictMode><App /></StrictMode>)
    await advanceTime(0)
    expect(fetch.overview()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await fetch.overview()[0].json(makeOverview())
    await advanceTime(5_000)
    expect(fetch.overview()).toHaveLength(2)
  })

  it('keeps overview and history ownership independent across overview updates', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    await fetch.overview()[0].json(makeOverview())
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory())
    await selectValue(view.container, 'Time window', '1h')
    await advanceTime(0)
    await act(async () => view.container.querySelector('button')!.click())
    expect(fetch.history()).toHaveLength(2)
    expect(fetch.overview()).toHaveLength(2)
    await advanceTime(5_000)
    expect(fetch.history()).toHaveLength(2)
    expect(fetch.overview()).toHaveLength(2)
    await fetch.overview()[1].json(makeOverview(99))
    expect(view.container.querySelectorAll('select')[1].value).toBe('1h')
    expect(fetch.history()[1].signal?.aborted).toBe(false)
    await fetch.history()[1].json(makeHistory('ap-001', '1h', 77))
    expect(view.container.querySelector('.history-panel tbody td:nth-child(3)')?.textContent).toBe('77')
    expect(firstClientCount(view.container)).toBe('99')
  })
})

describe('incident integration contract', () => {
  it('keeps Monitoring default and exposes Incidents navigation', async () => {
    controlFetch()
    const view = await render(<App />)
    expect(view.container.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Monitoring')
    expect(view.container.querySelector('a[href="?view=incidents"]')?.textContent).toBe('Incidents')
  })

  it('offers contextual creation only for affected APs and zones', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const overview = makeOverview()
    overview.accessPoints[0].operational = false
    overview.accessPoints[1].degraded = true
    await fetch.overview()[0].json(overview)
    expect(view.container.querySelectorAll('[aria-labelledby="aps-heading"] button')).toHaveLength(2)
    expect(view.container.querySelectorAll('.zone-card button')).toHaveLength(1)
  })

  it('loads a directly addressed stored incident independently of telemetry', async () => {
    window.history.replaceState(null, '', '/?view=incidents&incident=5')
    try {
      const fetch = controlFetch()
      const view = await render(<App />)
      await advanceTime(0)
      expect(fetch.requests.some(r => r.url === '/api/incidents/5')).toBe(true)
      expect(view.container.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Incidents')
    } finally { window.history.replaceState(null, '', '/') }
  })
})

describe('incident navigation preserves monitoring ownership',()=>{
 it('uses one overview poller while switching views and browser history',async()=>{
  const f=controlFetch(),v=await render(<App/>);await advanceTime(0);await f.overview()[0].json(makeOverview());await advanceTime(0)
  await act(async()=>v.container.querySelector<HTMLAnchorElement>('nav a[href="?view=incidents"]')!.click());expect(f.history().at(-1)?.signal?.aborted).toBe(true)
  await advanceTime(5_000);expect(f.overview()).toHaveLength(2);await advanceTime(10_000);expect(f.overview()).toHaveLength(2)
  await act(async()=>{history.replaceState(null,'','/');window.dispatchEvent(new PopStateEvent('popstate'))});expect(v.container.querySelector('nav [aria-current]')?.textContent).toBe('Monitoring')
  expect(f.overview()).toHaveLength(2)
 })
 it('preserves unsent create draft across navigation without submitting',async()=>{
  const f=controlFetch(),v=await render(<App/>);await advanceTime(0);const o=makeOverview();o.accessPoints[0].degraded=true;await f.overview()[0].json(o)
  await act(async()=>v.container.querySelector<HTMLButtonElement>('.zone-card button')!.click())
  const input=v.container.querySelector<HTMLInputElement>('#incident-create-title')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Unsent title');input.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>v.container.querySelector<HTMLAnchorElement>('nav a[href="?view=incidents"]')!.click())
  await act(async()=>[...v.container.querySelectorAll('button')].find(b=>b.textContent==='Continue incident draft')!.click())
  expect(v.container.querySelector<HTMLInputElement>('#incident-create-title')?.value).toBe('Unsent title');expect(f.requests.filter(r=>r.options?.method==='POST')).toHaveLength(0)
 })
 it('keeps invalid direct incident links scoped with a back link',async()=>{
  history.replaceState(null,'','/?view=incidents&incident=-1');controlFetch();const v=await render(<App/>);expect(v.container.textContent).toContain('Invalid incident link');expect(v.container.textContent).toContain('Back to incidents')
 })
})
