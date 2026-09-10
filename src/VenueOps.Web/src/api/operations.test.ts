import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAccessPointHistory, getOperationsOverview } from './operations'
import { makeHistory, makeOverview } from '../testUtils'

afterEach(() => vi.unstubAllGlobals())

describe('API request helpers', () => {
  it('forwards the overview signal and preserves its URL, headers and cache policy', async () => {
    const body = makeOverview()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const result = await getOperationsOverview(controller.signal)
    expect(fetch).toHaveBeenCalledWith('/api/operations/overview', {
      headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
    })
    expect(result).toEqual(body)
  })

  it('preserves history URL encoding, signal, headers and cache policy', async () => {
    const body = makeHistory()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const result = await getAccessPointHistory('ap/001 ?#', '1h', controller.signal)
    expect(fetch).toHaveBeenCalledWith('/api/operations/access-points/ap%2F001%20%3F%23/history?window=1h', {
      headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
    })
    expect(result).toEqual(body)
  })

  describe.each([
    { name: 'overview', load: getOperationsOverview, fallback: 'The operations API returned HTTP 503.' },
    { name: 'history', load: (signal?: AbortSignal) => getAccessPointHistory('ap-001', '15m', signal), fallback: 'The history API returned HTTP 503.' },
  ])('$name', ({ load, fallback }) => {
    it.each([
      { body: JSON.stringify({ detail: 'Detailed failure', title: 'Failure title' }), message: 'Detailed failure' },
      { body: JSON.stringify({ title: 'Failure title' }), message: 'Failure title' },
      { body: '{}', message: null },
      { body: 'not JSON', message: null },
    ])('preserves HTTP error handling for $body', async ({ body, message }) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 503 })))
      await expect(load()).rejects.toThrow(message ?? fallback)
    })

    it('propagates transport cancellation', async () => {
      const error = new DOMException('Aborted', 'AbortError')
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
      const controller = new AbortController()
      controller.abort()
      await expect(load(controller.signal)).rejects.toBe(error)
    })
  })
})
