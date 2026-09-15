import { useState } from 'react'
import { demoPresets, type DemoPresetId, type DemoScenariosController } from '../useDemoScenarios'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  controller: DemoScenariosController
}

export function DemoScenariosPanel({ open, onOpenChange, controller }: Props) {
  const [selected, setSelected] = useState<DemoPresetId | null>(null)
  const { status, checkedAt, busy, reading, readError, outcome } = controller
  const disabled = busy || reading
  return <section className="demo-scenarios" aria-label="Local demo controls">
    <button type="button" className="refresh-button" aria-expanded={open} aria-controls="demo-scenarios-content" onClick={() => onOpenChange(!open)}>Demo scenarios</button>
    {open && <div id="demo-scenarios-content">
      <p>These controls change synthetic state in the shared local simulator. Monitoring updates after collection. Incidents and existing monitoring history are retained.</p>
      <fieldset aria-label="Scenario presets" className="demo-scenario-options">
        <legend>Select a scenario, then apply it</legend>
        <div className="demo-scenario-cards">
          {demoPresets.map(preset => <label className="demo-scenario-option" key={preset.id}>
            <input type="radio" name="demo-scenario" value={preset.id} checked={selected === preset.id}
              onChange={() => setSelected(preset.id)}
              onFocus={event => {
                const card = event.currentTarget.closest('label')
                window.requestAnimationFrame(() => {
                  if (card?.contains(document.activeElement)) card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
                })
              }} />
            <strong>{preset.label}</strong>
            <span>{preset.description}</span>
          </label>)}
        </div>
      </fieldset>
      <p id="demo-playback-help">Automatic playback runs for approximately 11 minutes. Starting or restarting begins at minute 0 and clears AP overrides.</p>
      <div className="demo-actions">
        <button type="button" className="refresh-button" disabled={!selected || disabled} onClick={() => { if (selected) void controller.applyPreset(selected) }}>Apply scenario</button>
        <button type="button" className="refresh-button" disabled={disabled} aria-describedby="demo-playback-help" onClick={() => void controller.runEventDay()}>{status?.mode === 'running' ? 'Restart event day' : 'Run event day'}</button>
        <button type="button" className="refresh-button" disabled={disabled} onClick={() => void controller.reset()}>Reset to baseline</button>
        <button type="button" className="refresh-button" disabled={disabled} onClick={() => void controller.refresh()}>Refresh simulator status</button>
      </div>
      {reading && <p role="status">Reading simulator status…</p>}
      {readError && <p role="alert" className="error-banner">{readError} {status ? 'Showing the last confirmed simulator status; it may be stale.' : 'Simulator status is unavailable.'} Monitoring and incident requests remain separate.</p>}
      {outcome && <div role={['applying', 'confirmed', 'restart-required'].includes(outcome.kind) ? 'status' : 'alert'} className={['partial', 'unknown', 'mismatch', 'readback-failed', 'preflight-failed'].includes(outcome.kind) ? 'error-banner' : 'demo-outcome'}>
        <strong>{outcome.label}</strong>
        <p>{outcome.message}</p>
        {outcome.confirmed.length > 0 && <p>Commands confirmed accepted: {outcome.confirmed.join(' → ')}.</p>}
        {outcome.failedStep && <p>Stopped at: {outcome.failedStep}.</p>}
      </div>}
      {status && <section className="demo-status" aria-label="Confirmed simulator status">
        <h3>Simulator status</h3>
        <dl>
          <div><dt>Mode</dt><dd>{status.mode}</dd></div>
          {status.phase !== null && <div><dt>Phase</dt><dd>{status.phase}</dd></div>}
          {status.elapsedMinutes !== null && <div><dt>Virtual minute</dt><dd>{status.elapsedMinutes}</dd></div>}
          <div><dt>Normalized load</dt><dd>{status.normalizedLoad}</dd></div>
          {checkedAt && <div><dt>Status checked</dt><dd><time dateTime={checkedAt}>{new Date(checkedAt).toLocaleTimeString()}</time></dd></div>}
        </dl>
        <ul>{status.accessPoints.map(ap => <li key={ap.apId}>{ap.apId} ({ap.zone}): {ap.scenario === 'offline' ? 'Offline override' : 'Follows event profile'}</li>)}</ul>
        <p>Technical quality and alert states appear in the monitoring view after collection and evaluation.</p>
      </section>}
    </div>}
  </section>
}
