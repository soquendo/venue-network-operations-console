// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { parseIncidentLocation, incidentUrl, navigateIncident, listenIncidentNavigation } from './incidentNavigation'

describe('native incident navigation', () => {
  it.each(['/', '/?view=unknown', '/?incident=5'])('defaults to monitoring: %s', url => {
    expect(parseIncidentLocation(url).view).toBe('monitoring')
  })
  it('parses direct detail and preserves valid filters', () => {
    expect(parseIncidentLocation('/?view=incidents&incident=5&status=Open&zone=zone-a')).toEqual({ view:'incidents', incidentId:5, invalidIncident:false, status:'Open', zone:'zone-a' })
  })
  it.each(['0','-1','bad','1.5','9007199254740992',''])('rejects malformed/unsafe incident %s', id => {
    expect(parseIncidentLocation('/?view=incidents&incident='+id).invalidIncident).toBe(true)
  })
  it('normalizes unsupported filters without inventing an inventory', () => {
    const route=parseIncidentLocation('/?view=incidents&status=open&zone=unknown-zone')
    expect(route.status).toBeUndefined();expect(route.zone).toBeUndefined()
    expect(incidentUrl(route)).toBe('?view=incidents')
  })
  it('pushes navigation, replaces filters, and observes popstate', () => {
    const push=vi.spyOn(window.history,'pushState'), replace=vi.spyOn(window.history,'replaceState'), changed=vi.fn()
    const stop=listenIncidentNavigation(changed)
    navigateIncident({view:'incidents',incidentId:5,invalidIncident:false,status:'Open'},false)
    expect(push).toHaveBeenCalled();expect(changed).toHaveBeenCalledTimes(1)
    navigateIncident({view:'incidents',invalidIncident:false,zone:'zone-b'},true)
    expect(replace).toHaveBeenCalled();expect(changed).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new PopStateEvent('popstate'));expect(changed).toHaveBeenCalledTimes(3)
    stop();window.dispatchEvent(new PopStateEvent('popstate'));expect(changed).toHaveBeenCalledTimes(3)
    window.history.replaceState(null,'','/');vi.restoreAllMocks()
  })
})
