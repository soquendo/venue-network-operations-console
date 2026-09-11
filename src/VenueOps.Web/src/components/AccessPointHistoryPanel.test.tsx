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
    expect(rows[1].textContent).toContain('Healthy')
    expect(rows[1].querySelectorAll('td')[2].textContent).toBe('0.0%')
  })
})

function timelineHistory(
  points: ReadonlyArray<readonly [secondsFromStart: number, operational: boolean]>,
  window: HistoryWindow = '15m',
) {
  const history = makeHistory('ap-001', window)
  const baseSample = history.samples[0]
  history.samples = points.map(([seconds, operational]) => ({
    ...baseSample,
    observedAtUtc: new Date(Date.parse(history.startUtc) + seconds * 1000).toISOString(),
    operational,
    clients: operational ? 42 : 0,
    channelUtilizationRatio: operational ? 0.55 : null,
    managementLatencySeconds: operational ? 0.018 : null,
    managementPacketLossRatio: operational ? 0.002 : null,
  }))
  return history
}

async function showHistory(history: AccessPointHistory) {
  const fetch = controlFetch()
  const view = await render(<AccessPointHistoryPanel accessPoints={makeAccessPoints()} />)
  await selectValue(view.container, 'Time window', history.window)
  await advanceTime(0)
  await fetch.history()[0].json(history)
  return { ...view, fetch }
}

function timelineCells(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.state-timeline > span')]
}

function expectCell(cell: HTMLElement, left: number, width: number) {
  expect(cell.style.left).toMatch(/%$/)
  expect(cell.style.width).toMatch(/%$/)
  expect(Number.parseFloat(cell.style.left)).toBeCloseTo(left, 8)
  expect(Number.parseFloat(cell.style.width)).toBeCloseTo(width, 8)
}

function expectGaps(container: HTMLElement, leading: boolean, internal: boolean, trailing: boolean) {
  const description = container.querySelector('.state-timeline')?.getAttribute('aria-label')
  expect(description).toContain(`Leading gap: ${leading ? 'yes' : 'no'}.`)
  expect(description).toContain(`Internal gaps: ${internal ? 'yes' : 'no'}.`)
  expect(description).toContain(`Trailing gap: ${trailing ? 'yes' : 'no'}.`)
}

function summaryValue(container: HTMLElement, label: string) {
  const item = [...container.querySelectorAll('.history-summary > div')]
    .find((element) => element.querySelector('span')?.textContent === label)
  return item?.querySelector('strong')?.textContent
}

describe('held event history quality', () => {
  it('renders degraded cells and recovery without counting quality as operational transitions', async () => {
    const history = timelineHistory([[0, true], [5, true], [10, true]])
    Object.assign(history.samples[1], { degraded: true, clients: 84, channelUtilizationRatio: 0.95, managementLatencySeconds: 0.078, managementPacketLossRatio: 0.017 })
    const { container } = await showHistory(history)
    const cells = timelineCells(container)
    expect(cells.map(cell => cell.className)).toEqual(['timeline-up', 'timeline-degraded', 'timeline-up'])
    expect(cells[1].title).toContain('Degraded')
    expect(container.querySelector('.timeline-legend')?.textContent).toContain('Degraded')
    expect([...container.querySelectorAll('tbody tr')].map(row => row.querySelector('td')?.textContent)).toEqual(['Healthy', 'Degraded', 'Healthy'])
    expect(summaryValue(container, 'State changes')).toBe('0')
    expect(summaryValue(container, 'Offline samples')).toBe('0')
  })

  it('keeps availability counting and sparse geometry with degraded samples', async () => {
    const history = timelineHistory([[0, true], [5, false], [10, true], [25, true]])
    Object.assign(history.samples[2], { degraded: true })
    const { container } = await showHistory(history)
    const cells = timelineCells(container)
    expectCell(cells[2], 0.833333333333, 0.555555555556)
    expectCell(cells[3], 2.5, 0.555555555556)
    expectGaps(container, false, true, true)
    expect(summaryValue(container, 'State changes')).toBe('2')
    expect(summaryValue(container, 'Offline samples')).toBe('1')
  })

  it('gives an offline history observation precedence over a degraded flag', async () => {
    const history = timelineHistory([[0, false]])
    Object.assign(history.samples[0], { degraded: true })
    const { container } = await showHistory(history)
    expect(timelineCells(container)[0].className).toBe('timeline-down')
    expect(container.querySelector('tbody tr')?.textContent).toContain('Offline')
    expect(container.querySelector('tbody tr')?.textContent).toContain('Not observed')
  })

  it('replaces retained degraded history after a successful same-selection recovery', async () => {
    const peak = timelineHistory([[0, true]])
    Object.assign(peak.samples[0], { degraded: true })
    const { container, fetch } = await showHistory(peak)
    await advanceTime(5_000)
    await fetch.history()[1].reject(new Error('history unavailable'))
    expect(container.querySelector('.timeline-degraded')).not.toBeNull()
    expect(container.textContent).toContain('history unavailable')
    await advanceTime(5_000)
    await fetch.history()[2].json(timelineHistory([[0, true]]))
    expect(container.querySelector('.timeline-degraded')).toBeNull()
    expect(container.querySelector('tbody td')?.textContent).toBe('Healthy')
    expect(container.textContent).not.toContain('history unavailable')
  })
})

describe('history coverage and summaries', () => {
  // Expected percentages are fixture-specific constants, not calculated by a geometry helper.
  it.each([
    { window: '15m', step: 5, count: 181, edgeWidth: 0.277777777778, middleLeft: 49.722222222222, middleWidth: 0.555555555556, lastLeft: 99.722222222222 },
    { window: '1h', step: 15, count: 241, edgeWidth: 0.208333333333, middleLeft: 49.791666666667, middleWidth: 0.416666666667, lastLeft: 99.791666666667 },
    { window: '6h', step: 60, count: 361, edgeWidth: 0.138888888889, middleLeft: 49.861111111111, middleWidth: 0.277777777778, lastLeft: 99.861111111111 },
    { window: '24h', step: 300, count: 289, edgeWidth: 0.173611111111, middleLeft: 49.826388888889, middleWidth: 0.347222222222, lastLeft: 99.826388888889 },
  ] as const)('positions a complete $window grid across its requested bounds', async (fixture) => {
    const points = Array.from({ length: fixture.count }, (_, index) => [index * fixture.step, true] as const)
    const { container } = await showHistory(timelineHistory(points, fixture.window))
    const cells = timelineCells(container)
    expect(cells).toHaveLength(fixture.count)
    expectCell(cells[0], 0, fixture.edgeWidth)
    expectCell(cells[(fixture.count - 1) / 2], fixture.middleLeft, fixture.middleWidth)
    expectCell(cells.at(-1)!, fixture.lastLeft, fixture.edgeWidth)
    expectGaps(container, false, false, false)
    expect(summaryValue(container, 'State changes')).toBe('0')
  })

  it('leaves leading missing coverage neutral instead of stretching the first result to the start', async () => {
    const points = Array.from({ length: 91 }, (_, index) => [450 + index * 5, true] as const)
    const { container } = await showHistory(timelineHistory(points))
    expectCell(timelineCells(container)[0], 49.722222222222, 0.555555555556)
    expectGaps(container, true, false, false)
  })

  it('leaves trailing missing coverage neutral instead of stretching the final result to the end', async () => {
    const points = Array.from({ length: 91 }, (_, index) => [index * 5, true] as const)
    const { container } = await showHistory(timelineHistory(points))
    expectCell(timelineCells(container).at(-1)!, 49.722222222222, 0.555555555556)
    expectGaps(container, false, false, true)
  })

  it('leaves a missing internal query position neutral even when both neighboring states match', async () => {
    const points = Array.from({ length: 181 }, (_, index) => [index * 5, true] as const)
      .filter(([seconds]) => seconds !== 450)
    const { container } = await showHistory(timelineHistory(points))
    const cells = timelineCells(container)
    expect(cells).toHaveLength(180)
    expectCell(cells[89], 49.166666666667, 0.555555555556)
    expectCell(cells[90], 50.277777777778, 0.555555555556)
    expect(cells[89].className).toBe('timeline-up')
    expect(cells[90].className).toBe('timeline-up')
    expectGaps(container, false, true, false)
    expect(summaryValue(container, 'State changes')).toBe('0')
  })

  it('keeps adjacent offline observations and nullable telemetry as observed offline data', async () => {
    const { container } = await showHistory(timelineHistory([[445, true], [450, false], [455, false], [460, true]]))
    expect(timelineCells(container).map((cell) => cell.className)).toEqual([
      'timeline-up', 'timeline-down', 'timeline-down', 'timeline-up',
    ])
    expect(summaryValue(container, 'Samples')).toBe('4')
    expect(summaryValue(container, 'Offline samples')).toBe('2')
    expect(summaryValue(container, 'State changes')).toBe('2')
    const offlineRows = [...container.querySelectorAll('tbody .offline-row')]
    expect(offlineRows).toHaveLength(2)
    for (const row of offlineRows) {
      expect([...row.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual([
        'Offline', '0', 'Not observed', 'Not observed', 'Not observed',
      ])
    }
  })

  it('keeps every numeric zero as an observed value, including latest clients', async () => {
    const history = timelineHistory([[450, true]])
    Object.assign(history.samples[0], {
      clients: 0, channelUtilizationRatio: 0, managementLatencySeconds: 0, managementPacketLossRatio: 0,
    })
    const { container } = await showHistory(history)
    expect(timelineCells(container)).toHaveLength(1)
    expect(timelineCells(container)[0].className).toBe('timeline-up')
    expect(summaryValue(container, 'Latest clients')).toBe('0')
    expect(summaryValue(container, 'Offline samples')).toBe('0')
    expect([...container.querySelectorAll('tbody td')].map((cell) => cell.textContent)).toEqual([
      'Healthy', '0', '0.0%', '0.0 ms', '0.0%',
    ])
  })

  it('counts multiple genuine adjacent state transitions exactly', async () => {
    const { container } = await showHistory(timelineHistory([[300, true], [305, false], [310, true], [315, false]]))
    expect(summaryValue(container, 'State changes')).toBe('3')
  })

  it('does not count opposite states across a gap as a transition', async () => {
    const { container } = await showHistory(timelineHistory([[300, true], [305, false], [315, true], [320, false]]))
    expect(summaryValue(container, 'State changes')).toBe('2')
  })

  it('positions sparse ordered samples by elapsed time without inventing observations', async () => {
    const { container } = await showHistory(timelineHistory([[0, true], [300, false], [900, true]]))
    const cells = timelineCells(container)
    expect(cells).toHaveLength(3)
    expectCell(cells[0], 0, 0.277777777778)
    expectCell(cells[1], 33.055555555556, 0.555555555556)
    expectCell(cells[2], 99.722222222222, 0.277777777778)
    expectGaps(container, false, true, false)
    expect(summaryValue(container, 'Samples')).toBe('3')
    expect(summaryValue(container, 'State changes')).toBe('0')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('keeps ten minutes of collection within its small region of a 24-hour request', async () => {
    const { container } = await showHistory(timelineHistory([[85800, true], [86100, false], [86400, true]], '24h'))
    const cells = timelineCells(container)
    expect(cells).toHaveLength(3)
    expectCell(cells[0], 99.131944444444, 0.347222222222)
    expectCell(cells[1], 99.479166666667, 0.347222222222)
    expectCell(cells[2], 99.826388888889, 0.173611111111)
    expectGaps(container, true, false, false)
  })

  it.each([
    { seconds: 0, left: 0, leading: false, trailing: true },
    { seconds: 900, left: 99.722222222222, leading: true, trailing: false },
  ])('keeps a single observation at boundary $seconds visible as a half cell', async ({ seconds, left, leading, trailing }) => {
    const { container } = await showHistory(timelineHistory([[seconds, true]]))
    const cells = timelineCells(container)
    expect(cells).toHaveLength(1)
    expectCell(cells[0], left, 0.277777777778)
    expectGaps(container, leading, false, trailing)
  })

  it('clips near-boundary cells while preserving the missing interior', async () => {
    const { container } = await showHistory(timelineHistory([[0.001, true], [899.999, false]]))
    const cells = timelineCells(container)
    expectCell(cells[0], 0, 0.277888888889)
    expectCell(cells[1], 99.722111111111, 0.277888888889)
    expectGaps(container, false, true, false)
    expect(summaryValue(container, 'State changes')).toBe('0')
  })

  it('compares equivalent timestamp encodings by their instants', async () => {
    const history = timelineHistory([[300, true], [305, false]])
    history.samples[0].observedAtUtc = '2026-09-10T07:50:00-04:00'
    history.samples[1].observedAtUtc = '2026-09-10T11:50:05.000Z'
    const { container } = await showHistory(history)
    expect(summaryValue(container, 'State changes')).toBe('1')
  })

  it.each([
    { delta: 4.999, changes: '1' },
    { delta: 5, changes: '1' },
    { delta: 5.001, changes: '1' },
    { delta: 4.998, changes: '0' },
    { delta: 5.002, changes: '0' },
    { delta: 9.999, changes: '0' },
    { delta: 10, changes: '0' },
  ])('uses only the one-millisecond adjacency allowance for a $delta-second separation', async ({ delta, changes }) => {
    const { container } = await showHistory(timelineHistory([[300, true], [300 + delta, false]]))
    expect(summaryValue(container, 'State changes')).toBe(changes)
  })

  it.each([
    { delta: 4.999, firstWidth: 0.5555, secondLeft: 33.611055555556 },
    { delta: 5.001, firstWidth: 0.555611111111, secondLeft: 33.611166666667 },
  ])('meets at a shared midpoint for permitted $delta-second rounding', async ({ delta, firstWidth, secondLeft }) => {
    const { container } = await showHistory(timelineHistory([[300, true], [300 + delta, false]]))
    const cells = timelineCells(container)
    expectCell(cells[0], 33.055555555556, firstWidth)
    expectCell(cells[1], secondLeft, firstWidth)
    expectGaps(container, true, false, true)
  })

  it.each([
    { delta: 4.998, width: 0.555333333333, secondLeft: 33.611111111111 },
    { delta: 5.002, width: 0.555555555556, secondLeft: 33.611333333333 },
  ])('keeps cells separated outside the rounding allowance at $delta seconds', async ({ delta, width, secondLeft }) => {
    const { container } = await showHistory(timelineHistory([[300, true], [300 + delta, false]]))
    const cells = timelineCells(container)
    expectCell(cells[0], 33.055555555556, width)
    expectCell(cells[1], secondLeft, width)
    expectGaps(container, true, true, true)
    expect(summaryValue(container, 'State changes')).toBe('0')
  })

  it('exposes bounds, resolution, offline count, gap categories, and the meaning of cells accessibly', async () => {
    const history = timelineHistory([[300, false], [600, true]])
    const { container } = await showHistory(history)
    const timeline = container.querySelector('.state-timeline')!
    expect(timeline.getAttribute('role')).toBe('img')
    expect(timeline.getAttribute('aria-label')).toContain(history.startUtc)
    expect(timeline.getAttribute('aria-label')).toContain(history.endUtc)
    expect(timeline.getAttribute('aria-label')).toContain('5s resolution')
    expect(timeline.getAttribute('aria-label')).toContain('1 of 2 samples were offline')
    expectGaps(container, true, true, true)
    const descriptionId = timeline.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.textContent).toBe(
      'Cell width represents query resolution, not measured state duration. Empty areas were not observed. State changes compare adjacent samples. Quality changes do not count as operational state changes.',
    )
    expect(container.querySelector('.timeline-legend')?.textContent).toContain('Not observed')
    expect(timelineCells(container)[0].title).toContain('Offline')
    expect(timelineCells(container)[1].title).toContain('Healthy')
  })

  it('retains the original response geometry and bounds through a failed same-selection refresh', async () => {
    const history = timelineHistory([[450, true]])
    const { container, fetch } = await showHistory(history)
    const originalDescription = container.querySelector('.state-timeline')?.getAttribute('aria-label')
    await advanceTime(5_000)
    await fetch.history()[1].reject(new Error('Refresh unavailable'))
    await advanceTime(5_000)
    expectCell(timelineCells(container)[0], 49.722222222222, 0.555555555556)
    expect(container.querySelector('.state-timeline')?.getAttribute('aria-label')).toBe(originalDescription)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Refresh unavailable')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Showing the most recent successful range response.')
  })

  it('recomputes geometry from replacement response bounds after successful recovery', async () => {
    const history = timelineHistory([[450, true]])
    const { container, fetch } = await showHistory(history)
    await advanceTime(5_000)
    await fetch.history()[1].reject(new Error('Refresh unavailable'))
    await advanceTime(5_000)
    const replacement = {
      ...history,
      startUtc: '2026-09-10T11:50:00.000Z',
      endUtc: '2026-09-10T12:05:00.000Z',
    }
    await fetch.history()[2].json(replacement)
    expectCell(timelineCells(container)[0], 16.388888888889, 0.555555555556)
    expect(container.querySelector('.state-timeline')?.getAttribute('aria-label')).toContain(replacement.startUtc)
    expect(container.querySelector('.state-timeline')?.getAttribute('aria-label')).toContain(replacement.endUtc)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
