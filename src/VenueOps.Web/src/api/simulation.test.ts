import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSimulationStatus, sendSimulationCommand, type SimulationCommand } from './simulation'
import { deferred } from '../testUtils'

const baseline = () => ({ scenario: 'High-Density Event Day', mode: 'baseline', elapsedMinutes: null, phase: null, normalizedLoad: 0,
  accessPoints: ['ap-001', 'ap-002', 'ap-003', 'ap-004'].map((apId, i) => ({ apId, zone: i < 2 ? 'zone-a' : 'zone-b', scenario: 'healthy', operational: true, clients: [42,35,28,31][i], channelUtilizationRatio: .55, managementLatencySeconds: .018, managementPacketLossRatio: .002 })) })
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('strict simulator response strings', () => {
  it.each([
    { name: 'array', value: ['running'] },
    { name: 'object', value: { 0: 'running' } },
    { name: 'number', value: 1 },
    { name: 'boolean', value: true },
    { name: 'null', value: null },
  ])('rejects a $name mode in a successful response', async ({ value }) => {
    const response = { ...baseline(), mode: value, elapsedMinutes: 0, phase: 'PRE_OPEN' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response', status: 200, outcomeUnknown: true })
  })

  it.each([
    { name: 'array', value: ['PEAK_DENSITY'] },
    { name: 'object', value: { 0: 'PEAK_DENSITY' } },
    { name: 'number', value: 1 },
    { name: 'boolean', value: true },
    { name: 'null outside baseline', value: null },
  ])('rejects a $name phase in a successful response', async ({ value }) => {
    const response = { ...baseline(), mode: 'held', elapsedMinutes: 360, phase: value, normalizedLoad: 1 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response', status: 200 })
  })

  it.each(['array', 'object'] as const)('rejects an %s top-level scenario', async shape => {
    const response = { ...baseline(), scenario: shape === 'array' ? ['High-Density Event Day'] : { 0: 'High-Density Event Day' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response' })
  })

  it.each([
    { field: 'apId', value: ['ap-001'] },
    { field: 'apId', value: { 0: 'ap-001' } },
    { field: 'zone', value: ['zone-a'] },
    { field: 'zone', value: { 0: 'zone-a' } },
    { field: 'scenario', value: ['healthy'] },
    { field: 'scenario', value: { 0: 'healthy' } },
  ])('rejects a non-string AP $field: $value', async ({ field, value }) => {
    const response = baseline()
    Object.assign(response.accessPoints[0], { [field]: value })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response' })
  })

  it.each(['coerced duplicate IDs', 'coerced unique IDs', 'duplicate primitive ID', 'missing AP', 'extra AP', 'unknown AP'] as const)('rejects an inventory with %s', async problem => {
    const response = baseline()
    if (problem === 'coerced duplicate IDs') Object.assign(response, { accessPoints: response.accessPoints.map(() => ({ ...response.accessPoints[0], apId: ['ap-001'] })) })
    if (problem === 'coerced unique IDs') Object.assign(response, { accessPoints: response.accessPoints.map(ap => ({ ...ap, apId: [ap.apId] })) })
    if (problem === 'duplicate primitive ID') response.accessPoints[1] = { ...response.accessPoints[0] }
    if (problem === 'missing AP') response.accessPoints.pop()
    if (problem === 'extra AP') response.accessPoints.push({ ...response.accessPoints[0] })
    if (problem === 'unknown AP') response.accessPoints[0].apId = 'ap-999'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response' })
  })

  it.each([
    { field: 'apId', value: ['ap-001'] },
    { field: 'apId', value: { 0: 'ap-001' } },
    { field: 'zone', value: ['zone-a'] },
    { field: 'zone', value: { 0: 'zone-a' } },
    { field: 'scenario', value: ['offline'] },
    { field: 'scenario', value: { 0: 'offline' } },
  ])('rejects a non-string partial acknowledgement $field: $value', async ({ field, value }) => {
    const response = { apId: 'ap-001', zone: 'zone-a', scenario: 'offline', [field]: value }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(sendSimulationCommand('offline-1')).rejects.toMatchObject({ kind: 'response', status: 200, outcomeUnknown: true })
  })

  it.each([
    { mode: 'baseline', elapsedMinutes: null, phase: null, normalizedLoad: 0 },
    { mode: 'held', elapsedMinutes: 360, phase: 'PEAK_DENSITY', normalizedLoad: 1 },
    { mode: 'running', elapsedMinutes: 0, phase: 'PRE_OPEN', normalizedLoad: 0 },
    { mode: 'completed', elapsedMinutes: 660, phase: 'EVENT_CLOSE', normalizedLoad: 0 },
  ])('preserves valid $mode strings and the complete primitive AP inventory', async position => {
    const response = { ...baseline(), ...position }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    const result = await getSimulationStatus()
    expect(result).toEqual(response)
    expect(result.accessPoints.map(ap => ap.apId)).toEqual(['ap-001', 'ap-002', 'ap-003', 'ap-004'])
  })
})

describe('simulator requests', () => {
  it('reads a complete snapshot with no-store and an owned signal', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(baseline())))
    vi.stubGlobal('fetch', fetch)
    const parent = new AbortController()
    expect(await getSimulationStatus(parent.signal)).toEqual(baseline())
    expect(fetch).toHaveBeenCalledWith('/simulation/event-day', expect.objectContaining({ method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } }))
    expect(fetch.mock.calls[0][1].signal).not.toBe(parent.signal)
    expect(vi.getTimerCount()).toBe(0)
    expect(parent.signal.aborted).toBe(false)
  })

  it.each([
    ['reset', '/simulation/event-day/reset', 'POST', undefined],
    ['peak', '/simulation/event-day/position', 'PUT', { elapsedMinutes: 360 }],
    ['offline-1', '/simulation/access-points/ap-001', 'PUT', { scenario: 'offline' }],
    ['offline-2', '/simulation/access-points/ap-002', 'PUT', { scenario: 'offline' }],
    ['start', '/simulation/event-day/start', 'POST', undefined],
  ] as const)('sends the exact %s contract', async (command, url, method, body) => {
    const result = command.startsWith('offline') ? { apId: command === 'offline-1' ? 'ap-001' : 'ap-002', zone: 'zone-a', scenario: 'offline' } : baseline()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetch)
    expect(await sendSimulationCommand(command, undefined)).toEqual(result)
    const [path, options] = fetch.mock.calls[0]
    expect(path).toBe(url); expect(options.method).toBe(method)
    expect(options.body).toBe(body === undefined ? undefined : JSON.stringify(body))
    expect(options.headers).toEqual(body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' })
  })

  it.each([400, 404])('preserves HTTP %s rejection and bounded error field', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Rejected simulator input' }), { status })))
    await expect(sendSimulationCommand('reset')).rejects.toMatchObject({ kind: 'http', status, outcomeUnknown: false, message: 'Rejected simulator input' })
  })
  it('keeps a non-JSON 404 a known rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing route', { status: 404 })))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'http', status: 404, outcomeUnknown: false })
  })
  it('keeps server failure distinct from rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })))
    await expect(sendSimulationCommand('reset')).rejects.toMatchObject({ kind: 'server', status: 503, outcomeUnknown: true })
  })
  it('classifies transport failure without claiming rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(sendSimulationCommand('start')).rejects.toMatchObject({ kind: 'transport', outcomeUnknown: true })
  })
  it.each(['not JSON', JSON.stringify({ apId: 'ap-001', zone: 'zone-a', scenario: 'offline' }), JSON.stringify({ ...baseline(), mode: 'unknown' }), JSON.stringify({ ...baseline(), accessPoints: [] })])('rejects malformed/incomplete successful status: %s', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response', outcomeUnknown: true })
  })
  it.each([
    { apId: 'ap-002', zone: 'zone-a', scenario: 'offline' },
    { apId: 'ap-001', zone: 'zone-b', scenario: 'offline' },
    { apId: 'ap-001', zone: 'zone-a', scenario: 'healthy' },
  ])('rejects an unexpected AP acknowledgement', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(sendSimulationCommand('offline-1')).rejects.toMatchObject({ kind: 'response' })
  })
  it('preserves offline zero/null values', async () => {
    const state = baseline()
    Object.assign(state.accessPoints[0], { scenario: 'offline', operational: false, clients: 0, channelUtilizationRatio: null, managementLatencySeconds: null, managementPacketLossRatio: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(state))))
    expect(await getSimulationStatus()).toEqual(state)
  })
  it.each(['duplicate AP', 'wrong zone', 'offline numeric zero', 'invalid load', 'invalid minute', 'invalid completion'] as const)('rejects %s in complete status', async problem => {
    const value = baseline()
    if (problem === 'duplicate AP') value.accessPoints[1] = { ...value.accessPoints[0] }
    if (problem === 'wrong zone') value.accessPoints[0].zone = 'zone-b'
    if (problem === 'offline numeric zero') Object.assign(value.accessPoints[0], { operational: false, scenario: 'offline', clients: 0, channelUtilizationRatio: 0 })
    if (problem === 'invalid load') value.normalizedLoad = 2
    if (problem === 'invalid minute') Object.assign(value, { mode: 'held', elapsedMinutes: '360', phase: 'PEAK_DENSITY' })
    if (problem === 'invalid completion') Object.assign(value, { mode: 'completed', elapsedMinutes: 400, phase: 'PEAK_DENSITY' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))))
    await expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'response' })
  })
  it('bounds provider error copy without displaying an entire response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'x'.repeat(1000) }), { status: 400 })))
    await expect(getSimulationStatus()).rejects.toMatchObject({ message: 'x'.repeat(200), kind: 'http' })
  })
  it.each(['fetch', 'body'])('enforces ten seconds through the %s stage even if abort is ignored', async stage => {
    const pending = deferred<Response>(), body = deferred<unknown>()
    const response = new Response('{}'); vi.spyOn(response, 'json').mockReturnValue(body.promise)
    const fetch = vi.fn().mockReturnValue(stage === 'fetch' ? pending.promise : Promise.resolve(response))
    vi.stubGlobal('fetch', fetch)
    const check = expect(getSimulationStatus()).rejects.toMatchObject({ kind: 'timeout', outcomeUnknown: true })
    await vi.advanceTimersByTimeAsync(10_000); await check
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    pending.resolve(new Response(JSON.stringify(baseline()))); body.resolve(baseline())
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates caller cancellation without aborting the caller or accepting a late body', async () => {
    const body = deferred<unknown>(), response = new Response('{}')
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch)
    const parent = new AbortController()
    const check = expect(getSimulationStatus(parent.signal)).rejects.toMatchObject({ kind: 'aborted', outcomeUnknown: true })
    await vi.advanceTimersByTimeAsync(0); parent.abort(); await check
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    body.resolve(baseline()); await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not dispatch for an already cancelled owner', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const parent = new AbortController(); parent.abort()
    await expect(getSimulationStatus(parent.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects a command outside the fixed catalog before dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(sendSimulationCommand('other' as SimulationCommand)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
