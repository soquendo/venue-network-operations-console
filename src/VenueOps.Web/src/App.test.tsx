// @vitest-environment jsdom
import { act, Activity, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { advanceTime, controlFetch, deferred, makeHistory, makeOverview, render, selectValue, setupDomTests } from './testUtils'
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

  it('gives offline availability precedence over degraded flags for APs and zones', async () => {
    const fetch = controlFetch()
    const view = await render(<App />)
    await advanceTime(0)
    const overview = makeOverview()
    Object.assign(overview.accessPoints[0], { operational: false, degraded: true, alertState: 'firing' })
    Object.assign(overview.zones[0], { operationalRatio: 0.5, degradedAccessPoints: 1 })
    await fetch.overview()[0].json(overview)
    expect(view.container.querySelector('[aria-labelledby="aps-heading"] .status-badge')?.textContent).toBe('Offline')
    expect(view.container.querySelector('.zone-card .status-badge')?.textContent).toBe('Offline')
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
