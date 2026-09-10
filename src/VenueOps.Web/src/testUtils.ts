import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'
import type {
  AccessPointHistory,
  AccessPointObservation,
  HistoryWindow,
  OperationsOverview,
} from './api/operations'

const mounted = new Set<() => void>()

export function setupDomTests() {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await act(async () => {
      for (const unmount of mounted) unmount()
    })
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
}

export async function render(element: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const unmount = () => {
    root.unmount()
    container.remove()
    mounted.delete(unmount)
  }
  mounted.add(unmount)
  await act(async () => root.render(element))

  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next))
    },
    unmount: async () => {
      await act(async () => unmount())
    },
  }
}

export async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

export async function selectValue(container: HTMLElement, label: string, value: string) {
  const control = [...container.querySelectorAll('label')]
    .find((element) => element.querySelector('span')?.textContent === label)
    ?.querySelector('select')
  if (!control) throw new Error('Missing select: ' + label)

  await act(async () => {
    control.value = value
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function controlFetch() {
  const requests: Array<{
    url: string
    options: RequestInit | undefined
    signal: AbortSignal | null | undefined
    respond: (response: Response) => Promise<void>
    json: (body: unknown, status?: number) => Promise<void>
    reject: (reason: unknown) => Promise<void>
  }> = []

  vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => {
    const response = deferred<Response>()
    // Deliberately ignore abort events: late settlements must also be rejected by ownership checks.
    requests.push({
      url: String(input),
      options,
      signal: options?.signal,
      respond: async (value) => {
        await act(async () => response.resolve(value))
      },
      json: async (body, status = 200) => {
        await act(async () => response.resolve(new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })))
      },
      reject: async (reason) => {
        await act(async () => response.reject(reason))
      },
    })
    return response.promise
  })

  return {
    requests,
    overview: () => requests.filter((request) => request.url === '/api/operations/overview'),
    history: () => requests.filter((request) => request.url.includes('/history?')),
  }
}

export function makeAccessPoints(): AccessPointObservation[] {
  return ['ap-001', 'ap-002', 'ap-003', 'ap-004'].map((apId, index) => ({
    apId,
    zone: index < 2 ? 'zone-a' : 'zone-b',
    operational: true,
    clients: [42, 35, 28, 31][index],
    channelUtilizationRatio: 0.55,
    managementLatencySeconds: 0.018,
    managementPacketLossRatio: 0.002,
    alertState: 'inactive',
    source: 'simulated',
    observedAtUtc: '2026-09-10T12:00:00Z',
  }))
}

export function makeHistory(
  apId = 'ap-001',
  window: HistoryWindow = '15m',
  clients = 42,
): AccessPointHistory {
  const durationSeconds = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 }[window]
  const endUtc = '2026-09-10T12:00:00Z'
  return {
    apId,
    zone: makeAccessPoints().find((ap) => ap.apId === apId)?.zone ?? 'zone-a',
    window,
    startUtc: new Date(Date.parse(endUtc) - durationSeconds * 1000).toISOString(),
    endUtc,
    stepSeconds: { '15m': 5, '1h': 15, '6h': 60, '24h': 300 }[window],
    source: 'simulated',
    samples: [{
      observedAtUtc: endUtc,
      operational: true,
      clients,
      channelUtilizationRatio: 0.55,
      managementLatencySeconds: 0.018,
      managementPacketLossRatio: 0.002,
    }],
  }
}

export function makeOverview(clients = 42): OperationsOverview {
  const accessPoints = makeAccessPoints()
  accessPoints[0].clients = clients
  return {
    generatedAtUtc: '2026-09-10T12:00:00Z',
    accessPoints,
    zones: ['zone-a', 'zone-b'].map((zone) => ({
      zone,
      operationalRatio: 1,
      clients: accessPoints.filter((ap) => ap.zone === zone).reduce((sum, ap) => sum + ap.clients, 0),
      source: 'derived',
      observedAtUtc: '2026-09-10T12:00:00Z',
    })),
    probe: {
      target: 'http://venue-api:8080/health/live',
      success: true,
      durationSeconds: 0.012,
      httpStatusCode: 200,
      source: 'measured',
      observedAtUtc: '2026-09-10T12:00:00Z',
    },
    simulatorScrape: {
      up: true,
      value: 1,
      source: 'measured',
      observedAtUtc: '2026-09-10T12:00:00Z',
    },
  }
}
