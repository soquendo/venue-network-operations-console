// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { useDemoScenarios, type DemoPresetId, type DemoScenariosController } from './useDemoScenarios'
import { advanceTime, controlFetch, makeOverview, render, setupDomTests } from './testUtils'

setupDomTests()
function status(mode = 'baseline', offline: string[] = [], minute = 360) {
  return { scenario: 'High-Density Event Day', mode, elapsedMinutes: mode === 'baseline' ? null : mode === 'completed' ? 660 : minute,
    phase: mode === 'baseline' ? null : mode === 'completed' ? 'EVENT_CLOSE' : mode === 'running' ? 'PRE_OPEN' : 'PEAK_DENSITY', normalizedLoad: mode === 'baseline' || mode === 'completed' ? 0 : 1,
    accessPoints: makeOverview().accessPoints.map(ap => offline.includes(ap.apId) ? { ...ap, scenario: 'offline', operational: false, clients: 0, channelUtilizationRatio: null, managementLatencySeconds: null, managementPacketLossRatio: null } : { ...ap, scenario: 'healthy' }) }
}
async function harness(visible = false, strict = false) {
  let current!: DemoScenariosController
  function Host({ shown }: { shown: boolean }) {
    const value = useDemoScenarios(shown)
    useEffect(() => { current = value }, [value])
    return null
  }
  const tree = (shown: boolean) => strict ? <StrictMode><Host shown={shown} /></StrictMode> : <Host shown={shown} />
  const view = await render(tree(visible))
  return { get current() { return current }, view, show: (shown: boolean) => view.rerender(tree(shown)) }
}
const mutations = (f: ReturnType<typeof controlFetch>) => f.requests.filter(r => r.options?.method !== 'GET')
async function start(h: Awaited<ReturnType<typeof harness>>, id: DemoPresetId) { await act(async () => { void h.current.applyPreset(id) }) }
async function acknowledge(r: ReturnType<typeof controlFetch>['requests'][number]) {
  await r.json(r.url.includes('access-points') ? { apId: r.url.split('/').at(-1), zone: 'zone-a', scenario: 'offline' } : status())
}

describe('scenario sequence ownership', () => {
  it.each([
    ['normal', ['/reset'], 'baseline', []],
    ['congestion', ['/reset', '/position'], 'held', []],
    ['single-outage', ['/reset', '/ap-001'], 'baseline', ['ap-001']],
    ['mixed', ['/reset', '/position', '/ap-001'], 'held', ['ap-001']],
    ['zone-outage', ['/reset', '/ap-001', '/ap-002'], 'baseline', ['ap-001', 'ap-002']],
  ] as const)('freezes and executes %s in order with preflight/final readback', async (id, paths, mode, offline) => {
    const f = controlFetch(), h = await harness()
    await start(h, id); expect(f.requests[0].options?.method).toBe('GET')
    await f.requests[0].json(status())
    for (let i = 0; i < paths.length; i++) {
      expect(f.requests[i + 1].url.endsWith(paths[i])).toBe(true)
      if (paths[i] === '/position') expect(f.requests[i + 1].options?.body).toBe('{"elapsedMinutes":360}')
      await acknowledge(f.requests[i + 1])
    }
    expect(f.requests.at(-1)?.options?.method).toBe('GET')
    await f.requests.at(-1)!.json(status(mode, [...offline]))
    expect(h.current.outcome?.kind).toBe('confirmed'); expect(h.current.busy).toBe(false)
    expect(h.current.outcome?.confirmed).toHaveLength(paths.length)
    expect(mutations(f)).toHaveLength(paths.length)
  })

  it('blocks synchronous duplicate and competing submissions through final readback', async () => {
    const f = controlFetch(), h = await harness()
    await act(async () => { void h.current.applyPreset('single-outage'); void h.current.applyPreset('zone-outage'); void h.current.reset(); void h.current.runEventDay() })
    expect(f.requests).toHaveLength(1)
    await f.requests[0].json(status()); await acknowledge(f.requests[1]); await acknowledge(f.requests[2])
    await act(async () => { void h.current.reset(); void h.current.refresh() })
    expect(f.requests).toHaveLength(4)
    await f.requests[3].json(status('baseline', ['ap-001']))
    expect(h.current.outcome?.kind).toBe('confirmed')
  })

  it('sends no mutation when preflight fails', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'mixed'); await f.requests[0].reject(new TypeError('offline'))
    expect(mutations(f)).toHaveLength(0); expect(h.current.outcome?.kind).toBe('preflight-failed')
    expect(h.current.busy).toBe(false); await advanceTime(30_000); expect(f.requests).toHaveLength(1)
  })

  it.each([0, 1, 2])('stops at rejected mixed step %i and reconciles exactly once', async failed => {
    const f = controlFetch(), h = await harness()
    await start(h, 'mixed'); await f.requests[0].json(status())
    for (let i = 0; i < failed; i++) await acknowledge(f.requests[i + 1])
    await f.requests[failed + 1].json({ error: 'Command rejected' }, 400)
    expect(mutations(f)).toHaveLength(failed + 1)
    expect(h.current.outcome?.confirmed).toHaveLength(failed)
    expect(h.current.outcome?.kind).toBe('partial')
    await f.requests.at(-1)!.json(status())
    await advanceTime(30_000); expect(f.requests).toHaveLength(failed + 3)
    expect(h.current.busy).toBe(false)
  })

  it('preserves unknown outcome even when readback matches and does not retry', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'single-outage'); await f.requests[0].json(status()); await acknowledge(f.requests[1])
    await f.requests[2].reject(new TypeError('lost response'))
    await f.requests[3].json(status('baseline', ['ap-001']))
    expect(h.current.outcome?.kind).toBe('unknown'); expect(h.current.outcome?.confirmed).toHaveLength(1)
    expect(h.current.status?.accessPoints[0].operational).toBe(false)
    await advanceTime(30_000); expect(f.requests).toHaveLength(4)
  })

  it('bounds both the failed mutation and its one failed reconciliation', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'zone-outage'); await f.requests[0].json(status())
    await advanceTime(10_000)
    expect(f.requests[1].signal?.aborted).toBe(true)
    expect(f.requests).toHaveLength(3)
    await advanceTime(10_000)
    expect(h.current.outcome?.kind).toBe('unknown'); expect(h.current.readError).toBeTruthy()
    expect(h.current.busy).toBe(false)
    await acknowledge(f.requests[1]); await f.requests[2].json(status())
    expect(f.requests).toHaveLength(3); expect(h.current.outcome?.kind).toBe('unknown')
  })

  it('reports final state mismatch rather than optimistic preset success', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'congestion'); await f.requests[0].json(status()); await acknowledge(f.requests[1]); await acknowledge(f.requests[2]); await f.requests[3].json(status())
    expect(h.current.outcome?.kind).toBe('mismatch')
  })
  it('keeps accepted commands separate from failed final readback', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'normal'); await f.requests[0].json(status()); await acknowledge(f.requests[1]); await f.requests[2].json({}, 503)
    expect(h.current.outcome?.kind).toBe('readback-failed'); expect(h.current.outcome?.confirmed).toHaveLength(1)
  })
  it('rejects coerced duplicate AP identifiers in final reset readback without confirming success', async () => {
    const f = controlFetch(), h = await harness()
    const before = status()
    await act(async () => { void h.current.reset() })
    await f.requests[0].json(before)
    await acknowledge(f.requests[1])
    const malformed = { ...status(), accessPoints: Array.from({ length: 4 }, () => ({ ...before.accessPoints[0], apId: ['ap-001'] })) }
    await f.requests[2].json(malformed)
    expect(h.current.outcome?.kind).toBe('readback-failed')
    expect(h.current.outcome?.confirmed).toEqual(['Reset to baseline'])
    expect(h.current.readError).toContain('unexpected response')
    expect(h.current.status).toEqual(before)
    expect(h.current.busy).toBe(false)
    await advanceTime(30_000)
    expect(f.requests).toHaveLength(3)
    expect(mutations(f)).toHaveLength(1)
    expect(h.current.outcome?.kind).toBe('readback-failed')
  })
  it('stops at a rejected second offline override without losing the first accepted override', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'zone-outage'); await f.requests[0].json(status())
    await acknowledge(f.requests[1]); await acknowledge(f.requests[2])
    await f.requests[3].json({ error: 'Access point was not found.' }, 404)
    expect(h.current.outcome?.kind).toBe('partial')
    expect(h.current.outcome?.confirmed).toEqual(['Reset to baseline', 'Set ap-001 offline'])
    expect(h.current.outcome?.failedStep).toBe('Set ap-002 offline')
    await f.requests[4].json(status('baseline', ['ap-001']))
    await advanceTime(30_000); expect(f.requests).toHaveLength(5)
    expect(h.current.status?.accessPoints[0].operational).toBe(false)
  })
  it('keeps the frozen action when another preset is selected during dispatch', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'mixed'); await f.requests[0].json(status())
    await start(h, 'normal')
    await acknowledge(f.requests[1]); await acknowledge(f.requests[2]); await acknowledge(f.requests[3])
    await f.requests[4].json(status('held', ['ap-001']))
    expect(mutations(f).map(r => r.url)).toEqual(['/simulation/event-day/reset', '/simulation/event-day/position', '/simulation/access-points/ap-001'])
    expect(h.current.outcome?.label).toBe('Mixed outage and congestion')
  })
  it('requires explicit Restart if Run preflight discovers an external running event', async () => {
    const f = controlFetch(), h = await harness()
    await act(async () => { void h.current.runEventDay() }); await f.requests[0].json(status('running', [], 10))
    expect(h.current.outcome?.kind).toBe('restart-required'); expect(mutations(f)).toHaveLength(0)
    await act(async () => { void h.current.runEventDay() }); await f.requests[1].json(status('running', [], 20))
    expect(f.requests[2].url).toBe('/simulation/event-day/start'); await f.requests[2].json(status('running', [], 0)); await f.requests[3].json(status('running', [], 1))
    expect(h.current.outcome?.kind).toBe('confirmed')
  })
  it('never retries Start after an uncertain response', async () => {
    const f = controlFetch(), h = await harness()
    await act(async () => { void h.current.runEventDay() }); await f.requests[0].json(status()); await f.requests[1].reject(new Error('lost')); await f.requests[2].json(status('running', [], 1))
    await advanceTime(30_000)
    expect(mutations(f)).toHaveLength(1); expect(h.current.outcome?.kind).toBe('unknown')
  })
  it('finishes across panel collapse/internal navigation and retains the result', async () => {
    const f = controlFetch(), h = await harness(true)
    await f.requests[0].json(status()); await start(h, 'single-outage'); await f.requests[1].json(status())
    await h.show(false); await acknowledge(f.requests[2]); await acknowledge(f.requests[3]); await f.requests[4].json(status('baseline', ['ap-001']))
    expect(h.current.outcome?.kind).toBe('confirmed')
    await h.show(true); expect(f.requests.at(-1)?.options?.method).toBe('GET')
    expect(h.current.outcome?.kind).toBe('confirmed')
  })
  it('invalidates teardown, prevents unsent steps and never resets automatically', async () => {
    const f = controlFetch(), h = await harness()
    await start(h, 'zone-outage'); await f.requests[0].json(status())
    await h.view.unmount(); expect(f.requests[1].signal?.aborted).toBe(true)
    await acknowledge(f.requests[1]); expect(f.requests).toHaveLength(2)
    const next = await harness(); await advanceTime(0)
    expect(next.current.outcome).toBeNull(); expect(f.requests).toHaveLength(2)
  })
})

describe('simulator status ownership', () => {
  it('does nothing on closed mount, even in Strict Mode', async () => {
    const f = controlFetch(); await harness(false, true); await advanceTime(30_000)
    expect(f.requests).toHaveLength(0)
  })
  it('reads on expansion and refresh, observes external changes without idle polling', async () => {
    const f = controlFetch(), h = await harness()
    await h.show(true); await f.requests[0].json(status()); await advanceTime(30_000); expect(f.requests).toHaveLength(1)
    await act(async () => { void h.current.refresh() }); await f.requests[1].json(status('baseline', ['ap-002']))
    expect(h.current.status?.accessPoints[1].scenario).toBe('offline'); expect(h.current.checkedAt).toBeTruthy()
  })
  it('polls only visible running status, skips busy ticks, and stops on completion', async () => {
    const f = controlFetch(); await harness(true)
    await f.requests[0].json(status('running', [], 1)); await advanceTime(5_000); expect(f.requests).toHaveLength(2)
    await advanceTime(5_000); expect(f.requests).toHaveLength(2)
    await f.requests[1].json(status('running', [], 12)); expect(f.requests).toHaveLength(2)
    await advanceTime(5_000); await f.requests[2].json(status('completed'))
    await advanceTime(20_000); expect(f.requests).toHaveLength(3)
  })
  it('stops polling on a read error, retains stale status, and recovers explicitly', async () => {
    const f = controlFetch(), h = await harness(true)
    await f.requests[0].json(status('running', [], 1)); await advanceTime(5_000); await f.requests[1].reject(new Error('down'))
    expect(h.current.status?.elapsedMinutes).toBe(1); expect(h.current.readError).toBeTruthy()
    await advanceTime(20_000); expect(f.requests).toHaveLength(2)
    await act(async () => { void h.current.refresh() }); await f.requests[2].json(status())
    expect(h.current.readError).toBeNull()
  })
  it('ignores an obsolete read after hide/return and preserves the new owner', async () => {
    const f = controlFetch(), h = await harness(true)
    await h.show(false); expect(f.requests[0].signal?.aborted).toBe(true)
    await h.show(true); await f.requests[1].json(status('held'))
    await f.requests[0].json(status())
    expect(h.current.status?.mode).toBe('held'); expect(h.current.reading).toBe(false)
    await h.show(false); await advanceTime(30_000); expect(f.requests).toHaveLength(2)
  })
  it('stops a running poll on collapse and reads fresh state on return', async () => {
    const f = controlFetch(), h = await harness(true)
    await f.requests[0].json(status('running', [], 10)); await advanceTime(5_000)
    await h.show(false); expect(f.requests[1].signal?.aborted).toBe(true)
    await advanceTime(20_000); expect(f.requests).toHaveLength(2)
    await h.show(true); await f.requests[2].json(status('held'))
    await f.requests[1].json(status('running', [], 12)); await advanceTime(20_000)
    expect(h.current.status?.mode).toBe('held'); expect(f.requests).toHaveLength(3)
  })
  it('does not insert running-status polls into a slow mutation sequence', async () => {
    const f = controlFetch(), h = await harness(true)
    await f.requests[0].json(status('running', [], 10))
    await act(async () => { void h.current.reset() }); await f.requests[1].json(status('running', [], 10))
    await advanceTime(5_000); expect(f.requests).toHaveLength(3)
    await acknowledge(f.requests[2]); await f.requests[3].json(status())
    await advanceTime(10_000); expect(f.requests).toHaveLength(4)
    expect(h.current.outcome?.kind).toBe('confirmed')
  })
})
