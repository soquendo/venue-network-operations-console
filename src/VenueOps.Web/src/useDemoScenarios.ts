import { useCallback, useEffect, useRef, useState } from 'react'
import { getSimulationStatus, sendSimulationCommand, SimulationError, type SimulationCommand, type SimulationStatus } from './api/simulation'

export const demoPresets = [
  { id: 'normal', label: 'Normal operations', description: 'Return all APs to baseline. Watch both zones recover and existing alerts clear after collection.', commands: ['reset'], held: false, offline: [] },
  { id: 'congestion', label: 'Event congestion', description: 'Hold event minute 360. Zone A stays online with two degraded APs and sustained degradation warnings. Zone B remains healthy at higher load.', commands: ['reset', 'peak'], held: true, offline: [] },
  { id: 'single-outage', label: 'Single AP outage', description: 'Take ap-001 offline. Watch Zone A show Partial outage and the AP-down alert progress.', commands: ['reset', 'offline-1'], held: false, offline: ['ap-001'] },
  { id: 'mixed', label: 'Mixed outage and congestion', description: 'Hold minute 360 and take ap-001 offline. Zone A has a partial outage while ap-002 remains degraded.', commands: ['reset', 'peak', 'offline-1'], held: true, offline: ['ap-001'] },
  { id: 'zone-outage', label: 'Zone outage', description: 'Take ap-001 and ap-002 offline. Watch Zone A show Offline and both AP-down alerts progress.', commands: ['reset', 'offline-1', 'offline-2'], held: false, offline: ['ap-001', 'ap-002'] },
] as const
export type DemoPresetId = typeof demoPresets[number]['id']
export type DemoOutcomeKind = 'applying' | 'confirmed' | 'partial' | 'unknown' | 'mismatch' | 'readback-failed' | 'preflight-failed' | 'restart-required'
export interface DemoOutcome {
  kind: DemoOutcomeKind
  label: string
  confirmed: string[]
  message: string
  failedStep?: string
}
export interface DemoScenariosController {
  status: SimulationStatus | null
  checkedAt: string | null
  busy: boolean
  reading: boolean
  readError: string | null
  outcome: DemoOutcome | null
  applyPreset: (id: DemoPresetId) => Promise<void>
  runEventDay: () => Promise<void>
  reset: () => Promise<void>
  refresh: () => Promise<void>
}
interface Operation { kind: 'read' | 'apply'; controller: AbortController }
interface Plan { label: string; commands: readonly SimulationCommand[]; held: boolean; offline: readonly string[]; start?: boolean; restart?: boolean }
const commandLabels: Record<SimulationCommand, string> = {
  reset: 'Reset to baseline', peak: 'Hold event minute 360', 'offline-1': 'Set ap-001 offline', 'offline-2': 'Set ap-002 offline', start: 'Start event day at minute 0',
}
function matches(plan: Plan, status: SimulationStatus) {
  const positionMatches = plan.start ? status.mode === 'running'
    : plan.held ? status.mode === 'held' && status.elapsedMinutes === 360 && status.normalizedLoad === 1
      : status.mode === 'baseline' && status.elapsedMinutes === null && status.normalizedLoad === 0
  return positionMatches && status.accessPoints.every(ap => ap.operational === !plan.offline.includes(ap.apId))
}
const message = (error: unknown) => error instanceof Error ? error.message : 'The simulator request could not be completed.'

export function useDemoScenarios(visible: boolean, enabled = true): DemoScenariosController {
  const [status, setStatus] = useState<SimulationStatus | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<DemoOutcome | null>(null)
  const active = useRef(false)
  const operation = useRef<Operation | null>(null)

  useEffect(() => {
    active.current = enabled
    return () => {
      active.current = false
      const previous = operation.current
      operation.current = null
      previous?.controller.abort()
    }
  }, [enabled])

  const owns = useCallback((owner: Operation) => active.current && operation.current === owner, [])
  const read = useCallback(async (owner: Operation) => {
    if (owns(owner)) setReading(true)
    try {
      const next = await getSimulationStatus(owner.controller.signal)
      if (owns(owner)) { setStatus(next); setCheckedAt(new Date().toISOString()); setReadError(null) }
      return next
    } catch (error) {
      if (owns(owner)) setReadError(message(error))
      throw error
    } finally { if (owns(owner)) setReading(false) }
  }, [owns])

  const refresh = useCallback(async () => {
    if (!active.current || operation.current) return
    const owner: Operation = { kind: 'read', controller: new AbortController() }
    operation.current = owner
    try { await read(owner) } catch { /* The read error is retained independently of any command outcome. */ }
    finally { if (owns(owner)) operation.current = null }
  }, [read, owns])

  useEffect(() => {
    let currentView = true
    if (enabled && visible) void Promise.resolve().then(() => { if (currentView) return refresh() })
    return () => {
      currentView = false
      // Hiding the panel cancels only standalone reads, never an explicit command sequence.
      const previous = operation.current
      if (previous?.kind === 'read') {
        operation.current = null
        previous.controller.abort()
        if (active.current) setReading(false)
      }
    }
  }, [visible, enabled, refresh])

  useEffect(() => {
    if (!enabled || !visible || status?.mode !== 'running' || readError) return
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [enabled, visible, status?.mode, readError, refresh])

  const execute = useCallback(async (requested: Plan) => {
    if (!active.current || operation.current) return
    const plan = { ...requested, commands: [...requested.commands], offline: [...requested.offline] }
    const owner: Operation = { kind: 'apply', controller: new AbortController() }
    // Guard ownership is acquired synchronously, before React can render disabled controls.
    operation.current = owner
    const confirmed: string[] = []
    const report = (kind: DemoOutcomeKind, detail: string, failedStep?: string) => {
      if (owns(owner)) setOutcome({ kind, label: plan.label, confirmed: [...confirmed], message: detail, failedStep })
    }
    setBusy(true)
    report('applying', 'Checking simulator status before sending commands.')
    try {
      let before: SimulationStatus
      try { before = await read(owner) } catch (error) {
        report('preflight-failed', `${message(error)} No commands were sent. Refresh simulator status before trying again.`)
        return
      }
      if (!owns(owner)) return
      if (plan.start && !plan.restart && before.mode === 'running') {
        report('restart-required', 'An event day is already running. Review its current position, then explicitly choose Restart event day to begin again at minute 0 and clear overrides.')
        return
      }
      for (const command of plan.commands) {
        if (!owns(owner)) return
        report('applying', `Sending: ${commandLabels[command]}.`)
        try { await sendSimulationCommand(command, owner.controller.signal) } catch (error) {
          if (!owns(owner)) return
          const unknown = !(error instanceof SimulationError) || error.outcomeUnknown
          report(unknown ? 'unknown' : 'partial', `${message(error)} ${unknown ? 'This command may have completed; its outcome is unknown.' : 'This command was rejected.'} No remaining steps will be sent. Current readback cannot identify which client caused the state. Review it before explicitly applying again or resetting.`, commandLabels[command])
          try { await read(owner) } catch { /* One bounded reconciliation only; keep the primary command outcome. */ }
          return
        }
        if (!owns(owner)) return
        confirmed.push(commandLabels[command])
        report('applying', 'Command accepted. Reading the final simulator state follows the remaining commands.')
      }
      let after: SimulationStatus
      try { after = await read(owner) } catch (error) {
        report('readback-failed', `All commands were accepted, but final simulator state could not be confirmed. ${message(error)} Refresh simulator status; commands will not be retried automatically.`)
        return
      }
      if (!owns(owner)) return
      if (matches(plan, after)) report('confirmed', 'Commands accepted. Simulator state matches the requested scenario. Watch the existing monitoring view as collection and alert evaluation catch up.')
      else report('mismatch', 'Commands were accepted, but current simulator state differs from the requested scenario. Another local client may have changed it. Review status before explicitly applying again or resetting.')
    } finally {
      if (owns(owner)) { operation.current = null; setBusy(false) }
    }
  }, [read, owns])

  return {
    status, checkedAt, busy, reading, readError, outcome, refresh,
    applyPreset: id => {
      const preset = demoPresets.find(item => item.id === id)
      return preset ? execute(preset) : Promise.resolve()
    },
    runEventDay: () => execute({ label: status?.mode === 'running' ? 'Restart event day' : 'Run event day', commands: ['start'], held: false, offline: [], start: true, restart: status?.mode === 'running' }),
    reset: () => execute({ label: 'Reset to baseline', commands: ['reset'], held: false, offline: [] }),
  }
}
