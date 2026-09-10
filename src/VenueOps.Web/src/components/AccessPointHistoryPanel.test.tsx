// @vitest-environment jsdom
import { act, Profiler, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AccessPointHistoryPanel } from './AccessPointHistoryPanel'
import { advanceTime, controlFetch, deferred, makeAccessPoints, makeHistory, render, selectValue, setupDomTests } from '../testUtils'
import type { AccessPointHistory, HistoryWindow } from '../api/operations'

setupDomTests()

describe('AccessPointHistoryPanel', () => {
  it('smoke: renders TSX using jsdom, deferred fetch and fake timers, then unmounts cleanly', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Loading')
    expect(fetch.requests).toHaveLength(0)

    await advanceTime(0)
    expect(fetch.history()).toHaveLength(1)
    await fetch.history()[0].json(makeHistory())
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('42')

    await view.unmount()
    expect(document.body.childElementCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await advanceTime(15_000)
    expect(fetch.history()).toHaveLength(1)
  })

  it.each([
    ['Access point', 'ap-002'],
    ['Time window', '1h'],
  ])('isolates retained data and errors on every commit after changing %s', async (label, value) => {
    const fetch = controlFetch()
    const commits: Array<{ apId: string; window: string; panel: boolean; error: string | null }> = []
    const view = await render(
      <Profiler id="history" onRender={() => {
        const controls = document.querySelectorAll('select')
        commits.push({
          apId: controls[0].value,
          window: controls[1].value,
          panel: document.querySelector('.history-panel') !== null,
          error: document.querySelector('[role="alert"]')?.textContent ?? null,
        })
      }}>
        <AccessPointHistoryPanel accessPoints={makeAccessPoints()} />
      </Profiler>,
    )
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(5_000)
    await fetch.history()[1].reject(new Error('Old selection failed'))
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Old selection failed')

    commits.length = 0
    await selectValue(view.container, label, value)
    const selectedCommits = commits.filter((commit) =>
      label === 'Access point' ? commit.apId === value : commit.window === value,
    )
    expect(selectedCommits.length).toBeGreaterThan(0)
    // Profiler observes commits before passive effects can reset old state.
    expect(selectedCommits.every((commit) => !commit.panel && commit.error === null)).toBe(true)
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Loading')
  })

  it.each([
    ['Access point', 'ap-002'],
    ['Time window', '1h'],
  ])('does not show the previous response when the new %s fails', async (label, value) => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory())
    await selectValue(view.container, label, value)
    await advanceTime(0)
    await fetch.history()[1].json({ detail: 'New selection failed' }, 503)

    expect(view.container.querySelector('.history-panel')).toBeNull()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('New selection failed')
    expect(view.container.textContent).not.toContain('Showing the most recent successful')
    expect(view.container.querySelector('[role="status"]')).toBeNull()
  })

  it.each(['success', 'failure'])('rejects an original A lifecycle %s after A → B → A', async (outcome) => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await selectValue(view.container, 'Access point', 'ap-002')
    await advanceTime(0)
    await selectValue(view.container, 'Access point', 'ap-001')
    await advanceTime(0)
    expect(fetch.history()).toHaveLength(3)
    expect(fetch.history()[0].signal?.aborted).toBe(true)

    if (outcome === 'success') await fetch.history()[0].json(makeHistory('ap-001', '15m', 111))
    else await fetch.history()[0].reject(new Error('Obsolete A failure'))
    expect(view.container.querySelector('.history-panel')).toBeNull()
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Loading')

    await fetch.history()[2].json(makeHistory('ap-001', '15m', 222))
    await fetch.history()[1].json(makeHistory('ap-002', '15m', 333))
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('222')
  })

  it('does not restore an earlier A snapshot when returning before B starts loading', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(5_000)
    await fetch.history()[1].reject(new Error('Earlier A refresh failed'))
    await selectValue(view.container, 'Access point', 'ap-002')
    await selectValue(view.container, 'Access point', 'ap-001')
    expect(view.container.querySelector('.history-panel')).toBeNull()
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Loading')
    await advanceTime(0)
    expect(fetch.history()).toHaveLength(3)
    await fetch.history()[2].json(makeHistory('ap-001', '15m', 222))
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('222')
  })

  it('ignores an obsolete failure after the current selection succeeds', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await selectValue(view.container, 'Access point', 'ap-002')
    await advanceTime(0)
    await fetch.history()[1].json(makeHistory('ap-002', '15m', 222))
    await fetch.history()[0].reject(new Error('Obsolete failure'))
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('222')
  })

  it('does not let an obsolete success clear the current error', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await selectValue(view.container, 'Access point', 'ap-002')
    await advanceTime(0)
    await fetch.history()[1].reject(new Error('Current failure'))
    await fetch.history()[0].json(makeHistory())
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Current failure')
    expect(view.container.querySelector('.history-panel')).toBeNull()
  })

  it('skips busy polling ticks without aborting or queuing the slow request', async () => {
    const fetch = controlFetch()
    await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await advanceTime(15_000)
    expect(fetch.history()).toHaveLength(1)
    expect(fetch.history()[0].signal?.aborted).toBe(false)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(4_999)
    expect(fetch.history()).toHaveLength(1)
    await advanceTime(1)
    expect(fetch.history()).toHaveLength(2)
    expect(fetch.history()[1].signal).not.toBe(fetch.history()[0].signal)
  })

  it('holds the guard while the response body is still pending', async () => {
    const fetch = controlFetch()
    await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    const body = deferred<AccessPointHistory>()
    const response = new Response('{}')
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    await fetch.history()[0].respond(response)
    await advanceTime(10_000)
    expect(fetch.history()).toHaveLength(1)
    await act(async () => body.resolve(makeHistory()))
    await advanceTime(5_000)
    expect(fetch.history()).toHaveLength(2)
  })

  it.each(['success', 'failure'])('does not release the current guard when an obsolete request settles with %s', async (outcome) => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await selectValue(view.container, 'Access point', 'ap-002')
    await advanceTime(0)
    if (outcome === 'success') await fetch.history()[0].json(makeHistory())
    else await fetch.history()[0].reject(new Error('Old failure'))
    await advanceTime(10_000)
    expect(fetch.history()).toHaveLength(2)
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Loading')
    await fetch.history()[1].json(makeHistory('ap-002'))
    await advanceTime(5_000)
    expect(fetch.history()).toHaveLength(3)
  })

  it('retains same-selection data and the refresh error until successful recovery', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(5_000)
    await fetch.history()[1].json({ detail: 'Refresh unavailable' }, 503)
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('42')
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Showing the most recent successful range response.')
    await advanceTime(5_000)
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Refresh unavailable')
    expect(view.container.querySelector('.history-panel')?.getAttribute('aria-busy')).toBe('true')
    await fetch.history()[2].json(makeHistory('ap-001', '15m', 99))
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('99')
    expect(view.container.querySelector('.history-panel')?.getAttribute('aria-busy')).toBe('false')
  })

  it.each([
    ['ap-002', '15m'],
    ['ap-001', '1h'],
  ] as const)('rejects returned identity %s / %s', async (apId, window) => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory(apId, window))
    expect(view.container.querySelector('.history-panel')).toBeNull()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('History refresh failed.')
  })

  it('retains only valid same-selection data when a refresh returns the wrong identity', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(5_000)
    await fetch.history()[1].json(makeHistory('ap-002', '15m', 222))
    expect(view.container.querySelector('tbody td:nth-child(3)')?.textContent).toBe('42')
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('History refresh failed.')
  })

  it.each([new Error(''), 'untyped rejection', new DOMException('Unexpected abort', 'AbortError')])(
    'makes a current uncancelled rejection explicit: %s', async (reason) => {
      const fetch = controlFetch()
      const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
      await advanceTime(0)
      await fetch.history()[0].reject(reason)
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('History refresh failed.')
    },
  )

  it('aborts on selection change and removes the previous polling lifecycle', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await advanceTime(2_000)
    await selectValue(view.container, 'Access point', 'ap-002')
    expect(fetch.history()[0].signal?.aborted).toBe(true)
    await advanceTime(0)
    await advanceTime(3_000)
    expect(fetch.history()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(1)
    await fetch.history()[0].reject(new DOMException('Aborted', 'AbortError'))
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('aborts pending work on unmount and ignores a later settlement', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    await view.unmount()
    expect(fetch.history()[0].signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(15_000)
    expect(fetch.history()).toHaveLength(1)
    expect(document.body.childElementCount).toBe(0)
  })

  it('clears the initial timer when unmounted before loading starts', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await view.unmount()
    await advanceTime(15_000)
    expect(fetch.requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves one polling lifecycle after Strict Mode setup and cleanup', async () => {
    const fetch = controlFetch()
    await render(<StrictMode><AccessPointHistoryPanel accessPoints={makeAccessPoints()} /></StrictMode>)
    await advanceTime(0)
    expect(fetch.history()).toHaveLength(1)
    expect(fetch.history()[0].signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await fetch.history()[0].json(makeHistory())
    await advanceTime(5_000)
    expect(fetch.history()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each<HistoryWindow>(['15m', '1h', '6h', '24h'])('continues to request the supported %s window', async (window) => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await selectValue(view.container, 'Time window', window)
    await advanceTime(0)
    expect(fetch.history()).toHaveLength(1)
    expect(fetch.history()[0].url).toBe('/api/operations/access-points/ap-001/history?window=' + window)
    await fetch.history()[0].json(makeHistory('ap-001', window))
    expect(view.container.querySelector('.history-panel')).not.toBeNull()
  })

  it('keeps valid zero measurements distinct from unavailable offline observations', async () => {
    const fetch = controlFetch()
    const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
    await advanceTime(0)
    const history = makeHistory()
    history.samples = [
      { ...history.samples[0], observedAtUtc: '2026-09-10T11:59:55Z', clients: 0, channelUtilizationRatio: 0, managementLatencySeconds: 0, managementPacketLossRatio: 0 },
      { ...history.samples[0], operational: false, clients: 0, channelUtilizationRatio: null, managementLatencySeconds: null, managementPacketLossRatio: null },
    ]
    await fetch.history()[0].json(history)
    const rows = view.container.querySelectorAll('tbody tr')
    expect(rows[0].textContent).toContain('Offline')
    expect(rows[0].querySelectorAll('td')[2].textContent).toBe('Not observed')
    expect(rows[1].textContent).toContain('Operational')
    expect(rows[1].querySelectorAll('td')[2].textContent).toBe('0.0%')
  })
})
