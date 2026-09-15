export type SimulationMode = 'baseline' | 'held' | 'running' | 'completed'
export type SimulationCommand = 'reset' | 'peak' | 'offline-1' | 'offline-2' | 'start'
export interface SimulationAccessPoint {
  apId: string
  zone: string
  scenario: 'healthy' | 'offline'
  operational: boolean
  clients: number
  channelUtilizationRatio: number | null
  managementLatencySeconds: number | null
  managementPacketLossRatio: number | null
}
export interface SimulationStatus {
  scenario: string
  mode: SimulationMode
  elapsedMinutes: number | null
  phase: string | null
  normalizedLoad: number
  accessPoints: SimulationAccessPoint[]
}
export interface SimulationAcknowledgement { apId: string; zone: string; scenario: 'offline' }
export type SimulationErrorKind = 'http' | 'server' | 'transport' | 'timeout' | 'response' | 'aborted'

export class SimulationError extends Error {
  readonly kind: SimulationErrorKind
  readonly status: number | null
  readonly outcomeUnknown: boolean
  constructor(kind: SimulationErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'SimulationError'
    this.kind = kind
    this.status = status
    this.outcomeUnknown = kind !== 'http' || status === 408
  }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const ratio = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const phases = ['PRE_OPEN', 'ARRIVAL', 'BUILDING_LOAD', 'PEAK_DENSITY', 'RECOVERY', 'EVENT_CLOSE']
function validStatus(value: unknown): value is SimulationStatus {
  if (!object(value) || typeof value.scenario !== 'string' || value.scenario !== 'High-Density Event Day'
    || typeof value.mode !== 'string' || !['baseline', 'held', 'running', 'completed'].includes(value.mode) || !ratio(value.normalizedLoad)) return false
  if (value.mode === 'baseline') {
    if (value.elapsedMinutes !== null || value.phase !== null || value.normalizedLoad !== 0) return false
  } else {
    if (!Number.isInteger(value.elapsedMinutes) || Number(value.elapsedMinutes) < 0 || Number(value.elapsedMinutes) > 660 || typeof value.phase !== 'string' || !phases.includes(value.phase)) return false
    if (value.mode === 'running' && value.elapsedMinutes === 660) return false
    if (value.mode === 'completed' && (value.elapsedMinutes !== 660 || value.phase !== 'EVENT_CLOSE' || value.normalizedLoad !== 0)) return false
  }
  const aps = value.accessPoints
  return Array.isArray(aps) && aps.length === 4 && aps.every(ap => {
    if (!object(ap) || typeof ap.apId !== 'string' || typeof ap.zone !== 'string' || typeof ap.scenario !== 'string'
      || !['ap-001', 'ap-002', 'ap-003', 'ap-004'].includes(ap.apId) || ap.zone !== (['ap-001', 'ap-002'].includes(ap.apId) ? 'zone-a' : 'zone-b')) return false
    if (ap.scenario === 'offline') return ap.operational === false && ap.clients === 0 && ap.channelUtilizationRatio === null && ap.managementLatencySeconds === null && ap.managementPacketLossRatio === null
    return ap.scenario === 'healthy' && ap.operational === true && Number.isSafeInteger(ap.clients) && Number(ap.clients) >= 0 && ratio(ap.channelUtilizationRatio) && ratio(ap.managementPacketLossRatio) && typeof ap.managementLatencySeconds === 'number' && Number.isFinite(ap.managementLatencySeconds) && ap.managementLatencySeconds >= 0
  }) && new Set(aps.map(ap => ap.apId)).size === 4
}

async function request<T>(path: string, method: string, body: unknown, valid: (value: unknown) => boolean, owner?: AbortSignal): Promise<T> {
  if (owner?.aborted) throw new SimulationError('aborted', 'Simulator request cancelled; a dispatched command may still have completed.')
  const controller = new AbortController()
  let rejectDeadline!: (reason: SimulationError) => void
  const interrupted = new Promise<never>((_, reject) => { rejectDeadline = reject })
  const cancel = () => {
    rejectDeadline(new SimulationError('aborted', 'Simulator request cancelled; a dispatched command may still have completed.'))
    controller.abort()
  }
  owner?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    rejectDeadline(new SimulationError('timeout', 'Simulator request timed out after 10 seconds.'))
    controller.abort()
  }, 10_000)
  const work = async () => {
    let response: Response
    try {
      response = await fetch(path, { method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: controller.signal })
    } catch {
      throw new SimulationError('transport', 'The local simulator could not be reached.')
    }
    let value: unknown
    try { value = await response.json() } catch {
      if (response.ok) throw new SimulationError('response', 'The simulator returned an unreadable response. Check local development simulator access.', response.status)
    }
    if (!response.ok) {
      const detail = object(value) && typeof value.error === 'string' && value.error.trim() ? value.error.slice(0, 200) : `The simulator returned HTTP ${response.status}.`
      throw new SimulationError(response.status >= 500 ? 'server' : 'http', detail, response.status)
    }
    if (response.status !== 200 || !valid(value)) throw new SimulationError('response', 'The simulator returned an unexpected response. Refresh simulator status before another action.', response.status)
    return value as T
  }
  try { return await Promise.race([interrupted, work()]) }
  finally { clearTimeout(timer); owner?.removeEventListener('abort', cancel) }
}

export function getSimulationStatus(signal?: AbortSignal): Promise<SimulationStatus> {
  return request('/simulation/event-day', 'GET', undefined, validStatus, signal)
}

export async function sendSimulationCommand(command: SimulationCommand, signal?: AbortSignal): Promise<SimulationStatus | SimulationAcknowledgement> {
  if (command === 'offline-1' || command === 'offline-2') {
    const apId = command === 'offline-1' ? 'ap-001' : 'ap-002'
    return request(`/simulation/access-points/${apId}`, 'PUT', { scenario: 'offline' }, value => object(value)
      && typeof value.apId === 'string' && value.apId === apId
      && typeof value.zone === 'string' && value.zone === 'zone-a'
      && typeof value.scenario === 'string' && value.scenario === 'offline', signal)
  }
  if (command === 'peak') return request('/simulation/event-day/position', 'PUT', { elapsedMinutes: 360 }, validStatus, signal)
  if (command === 'reset' || command === 'start') return request(`/simulation/event-day/${command}`, 'POST', undefined, validStatus, signal)
  throw new Error('Unsupported demo command.')
}
