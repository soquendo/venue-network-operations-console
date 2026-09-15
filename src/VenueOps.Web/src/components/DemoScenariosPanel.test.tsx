// @vitest-environment jsdom
import { act, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { DemoScenariosPanel } from './DemoScenariosPanel'
import type { DemoScenariosController } from '../useDemoScenarios'
import { clickButton, render, setupDomTests } from '../testUtils'

setupDomTests()
function controller(overrides: Partial<DemoScenariosController> = {}): DemoScenariosController {
  return { status: null, checkedAt: null, busy: false, reading: false, readError: null, outcome: null,
    applyPreset: vi.fn().mockResolvedValue(undefined), runEventDay: vi.fn().mockResolvedValue(undefined), reset: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined), ...overrides }
}
async function panel(c = controller(), initiallyOpen = false) {
  function Host() {
    const [open, setOpen] = useState(initiallyOpen)
    return <DemoScenariosPanel open={open} onOpenChange={setOpen} controller={c} />
  }
  return { ...await render(<Host />), controller: c }
}

it('starts collapsed and expansion does not apply or reset a scenario', async () => {
  const v = await panel()
  expect(v.container.querySelector('[aria-expanded="false"]')).not.toBeNull()
  expect(v.container.querySelector('input[type="radio"]')).toBeNull()
  await clickButton(v.container, 'Demo scenarios')
  expect(v.container.querySelector('[aria-expanded="true"]')).not.toBeNull()
  expect(v.container.textContent).toContain('shared local simulator')
  expect(v.controller.applyPreset).not.toHaveBeenCalled(); expect(v.controller.reset).not.toHaveBeenCalled()
})
it('uses an unselected native radio and only explicit Apply sends intent', async () => {
  const v = await panel(controller(), true)
  const radio = v.container.querySelector<HTMLInputElement>('input[value="single-outage"]')!
  const apply = [...v.container.querySelectorAll('button')].find(b => b.textContent === 'Apply scenario')!
  expect(radio.checked).toBe(false); expect(apply.disabled).toBe(true)
  await act(async () => { radio.focus(); radio.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); v.container.querySelector('fieldset')!.dispatchEvent(new Event('scroll')); radio.click() })
  expect(document.activeElement).toBe(radio)
  expect(radio.closest('label')?.textContent).toContain('Single AP outage')
  expect(apply.disabled).toBe(false); expect(v.controller.applyPreset).not.toHaveBeenCalled()
  await clickButton(v.container, 'Apply scenario')
  expect(v.controller.applyPreset).toHaveBeenCalledExactlyOnceWith('single-outage')
})
it.each(['busy', 'reading'] as const)('disables competing controls while %s', async key => {
  const v = await panel(controller({ [key]: true }), true)
  const actions = [...v.container.querySelectorAll('button')].filter(b => b.textContent !== 'Demo scenarios')
  expect(actions.every(b => b.disabled)).toBe(true)
  expect(v.controller.reset).not.toHaveBeenCalled()
})
it('shows confirmed state and browser check time without inferring technical health', async () => {
  const v = await panel(controller({ checkedAt: '2026-09-14T12:00:00Z', status: {
    scenario: 'High-Density Event Day', mode: 'held', elapsedMinutes: 360, phase: 'PEAK_DENSITY', normalizedLoad: 1,
    accessPoints: [{ apId: 'ap-001', zone: 'zone-a', scenario: 'healthy', operational: true, clients: 84, channelUtilizationRatio: .95, managementLatencySeconds: .078, managementPacketLossRatio: .017 }],
  } }), true)
  expect(v.container.textContent).toContain('held'); expect(v.container.textContent).toContain('PEAK_DENSITY')
  expect(v.container.textContent).toContain('360'); expect(v.container.textContent).toContain('Status checked')
  expect(v.container.textContent).toContain('Follows event profile')
  expect(v.container.textContent).not.toContain('ap-001: Healthy')
})
it.each(['partial', 'unknown', 'mismatch'] as const)('preserves the %s outcome and stale status warning', async kind => {
  const v = await panel(controller({ readError: 'Simulator unavailable', outcome: { kind, label: 'Single AP outage', confirmed: ['Reset to baseline'], failedStep: 'Set ap-001 offline', message: 'Review current state before applying again.' } }), true)
  expect(v.container.textContent).toContain('Simulator unavailable')
  expect(v.container.textContent).toContain('Reset to baseline')
  expect(v.container.textContent).toContain('Set ap-001 offline')
  expect(v.container.textContent).toContain('Review current state before applying again.')
  expect(v.container.querySelector('[role="alert"]')).not.toBeNull()
  expect(v.controller.applyPreset).not.toHaveBeenCalled()
})
it('refreshes and resets only through the explicit buttons', async () => {
  const v = await panel(controller(), true)
  await clickButton(v.container, 'Refresh simulator status'); expect(v.controller.refresh).toHaveBeenCalledOnce()
  await clickButton(v.container, 'Reset to baseline'); expect(v.controller.reset).toHaveBeenCalledOnce()
  await clickButton(v.container, 'Demo scenarios'); expect(v.controller.reset).toHaveBeenCalledOnce()
})

it('offers exactly the five fixed cards with no initial selection', async () => {
  const v = await panel(controller(), true)
  const radios = [...v.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(radios.map(r => r.value)).toEqual(['normal', 'congestion', 'single-outage', 'mixed', 'zone-outage'])
  expect(radios.every(r => r.name === 'demo-scenario' && !r.checked)).toBe(true)
  expect(radios.every(r => r.closest('label')?.querySelector('strong') && r.closest('label')?.querySelector('span')?.textContent)).toBe(true)
  expect(v.container.querySelector('.demo-scenario-cards')).not.toBeNull()
  expect(v.controller.applyPreset).not.toHaveBeenCalled()
})

it.each(['normal', 'congestion', 'single-outage', 'mixed', 'zone-outage'] as const)('applies only explicitly selected %s', async id => {
  const v = await panel(controller(), true)
  const radio = v.container.querySelector<HTMLInputElement>(`input[value="${id}"]`)!
  expect(radio).not.toBeNull()
  await act(async () => radio.click())
  expect(v.container.querySelectorAll('input:checked')).toHaveLength(1)
  expect(v.controller.applyPreset).not.toHaveBeenCalled()
  await clickButton(v.container, 'Apply scenario')
  expect(v.controller.applyPreset).toHaveBeenCalledExactlyOnceWith(id)
  expect(v.controller.runEventDay).not.toHaveBeenCalled()
})

it('brings the focused card into view after native focus scrolling without selecting or applying it', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  const v = await panel(controller(), true)
  const radio = v.container.querySelector<HTMLInputElement>('input[value="single-outage"]')!
  const scroll = vi.fn()
  radio.closest('label')!.scrollIntoView = scroll
  await act(async () => radio.focus())
  expect(scroll).not.toHaveBeenCalled()
  await act(async () => frames.forEach(callback => callback(0)))
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' })
  expect(radio.checked).toBe(false)
  expect(v.controller.applyPreset).not.toHaveBeenCalled()
})

it('does not scroll an obsolete card after focus moves or the panel closes', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  const v = await panel(controller(), true)
  const radios = [...v.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  const oldScroll = vi.fn(), currentScroll = vi.fn()
  radios[0].closest('label')!.scrollIntoView = oldScroll
  radios[1].closest('label')!.scrollIntoView = currentScroll
  await act(async () => { radios[0].focus(); radios[1].focus() })
  await act(async () => frames.splice(0).forEach(callback => callback(0)))
  expect(oldScroll).not.toHaveBeenCalled()
  expect(currentScroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' })
  await act(async () => radios[0].focus())
  await clickButton(v.container, 'Demo scenarios')
  await act(async () => frames.splice(0).forEach(callback => callback(0)))
  expect(oldScroll).not.toHaveBeenCalled()
  expect(v.controller.applyPreset).not.toHaveBeenCalled()
  expect(v.controller.reset).not.toHaveBeenCalled()
})

it.each(['baseline', 'held', 'running', 'completed'] as const)('uses the confirmed %s state for Run/Restart wording', async mode => {
  const c = controller({ status: { scenario: 'High-Density Event Day', mode, elapsedMinutes: mode === 'baseline' ? null : 360, phase: mode === 'baseline' ? null : 'PEAK_DENSITY', normalizedLoad: 0, accessPoints: [] } })
  const v = await panel(c, true)
  const label = mode === 'running' ? 'Restart event day' : 'Run event day'
  expect([...v.container.querySelectorAll('button')].map(b => b.textContent)).toContain(label)
  expect(v.container.textContent).toContain('minute 0')
  expect(v.container.textContent).toContain('clears AP overrides')
  expect(v.controller.runEventDay).not.toHaveBeenCalled()
  await clickButton(v.container, label)
  expect(v.controller.runEventDay).toHaveBeenCalledOnce()
  expect(v.controller.applyPreset).not.toHaveBeenCalled()
})

it('keeps a new selection separate from the retained command result', async () => {
  const c = controller({ outcome: { kind: 'confirmed', label: 'Single AP outage', confirmed: ['Reset to baseline', 'Set ap-001 offline'], message: 'Simulator state matches the requested scenario.' } })
  const v = await panel(c, true)
  await act(async () => v.container.querySelector<HTMLInputElement>('input[value="normal"]')!.click())
  expect(v.container.querySelector('input:checked')?.getAttribute('value')).toBe('normal')
  expect(v.container.querySelector('.demo-outcome')?.textContent).toContain('Single AP outage')
  expect(c.applyPreset).not.toHaveBeenCalled()
})
