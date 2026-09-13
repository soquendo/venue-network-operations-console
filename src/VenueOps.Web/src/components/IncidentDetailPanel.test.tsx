// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { IncidentDetailPanel } from './IncidentDetailPanel'
import { clickButton, controlFetch, enterText, makeIncident, makeIncidentEvent, makeOverview, render, setupDomTests } from '../testUtils'
import { workflowKey } from '../incidentRequestState'
setupDomTests()
const props={incidentId:5,overview:makeOverview(),overviewError:null,isOverviewLoading:false}
it('separates immutable captured evidence from current telemetry and missing alert occurrences',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident())
 expect(v.container.querySelector('[aria-labelledby="captured-heading"]')?.textContent).toContain('84')
 expect(v.container.querySelector('[aria-labelledby="current-network-heading"]')?.textContent).toContain('42')
 expect(v.container.textContent).toContain('No active occurrence captured')
})
it('labels retained current telemetry and keeps stored incident usable',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props} overviewError="Telemetry failed"/>);await f.requests[0].json(makeIncident())
 expect(v.container.textContent).toContain('Retained');expect(v.container.textContent).toContain('Telemetry failed');expect(v.container.textContent).toContain('Incident 5')
})
it('prepends earlier events without replacing current header and invalidates old pages',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json({...makeIncident(5,109),events:[makeIncidentEvent(10),makeIncidentEvent(109)],hasEarlierEvents:true,nextBeforeEventSequence:10})
 await clickButton(v.container,'Load earlier activity');await f.requests[1].json({...makeIncident(5,110),events:[makeIncidentEvent(1,'Created')],responderLabel:'Later',hasEarlierEvents:false,nextBeforeEventSequence:null})
 expect(v.container.querySelector('[data-incident-version]')?.textContent).toContain('109');expect(v.container.textContent).not.toContain('Later');expect(v.container.querySelectorAll('[data-event-sequence]')).toHaveLength(3)
 await clickButton(v.container,'Refresh incident');await f.requests[2].json(makeIncident(5,111));expect(v.container.querySelectorAll('[data-event-sequence]')).toHaveLength(1)
})
it.each(['success','failure'])('rejects late detail 5→8→5 %s',async outcome=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await v.rerender(<IncidentDetailPanel {...props} incidentId={8}/>);await v.rerender(<IncidentDetailPanel {...props}/>)
 await f.requests[2].json(makeIncident(5,9));if(outcome==='success')await f.requests[0].json(makeIncident(5,1));else await f.requests[0].reject(new Error('old'))
 expect(v.container.querySelector('[data-incident-version]')?.textContent).toContain('9');expect(v.container.querySelector('[role="alert"]')).toBeNull()
})
it('preserves note and reviews latest version after a definitive conflict without resubmitting',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident());await enterText(v.container,'Note','Investigated');await clickButton(v.container,'Add note')
 const mutation=f.requests[1];expect(JSON.parse(mutation.options!.body as string).expectedVersion).toBe(1)
 await mutation.json({title:'Changed',code:'version_conflict',currentVersion:2,currentStatus:'Open'},409)
 await f.requests[2].json(makeIncident(5,2));expect(v.container.querySelector<HTMLTextAreaElement>('#incident-note')?.value).toBe('Investigated')
 expect(v.container.textContent).toContain('Reviewed current state');expect(f.requests.filter(r=>r.options?.method==='POST')).toHaveLength(1)
})
it('keeps confirmed command success separate from failed latest-detail refresh',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident());await enterText(v.container,'Note','Saved note');await clickButton(v.container,'Add note')
 const body=JSON.parse(f.requests[1].options!.body as string)
 await f.requests[1].json({incidentId:5,commandId:body.commandId,version:2,event:{...makeIncidentEvent(2),commandId:body.commandId}})
 await f.requests[2].json({title:'Incident storage is unavailable'},503)
 expect(v.container.textContent).toContain('Action was saved, but latest incident state could not be refreshed');expect(sessionStorage.getItem(workflowKey(5))).toBeNull()
 expect(f.requests.filter(r=>r.options?.method==='POST')).toHaveLength(1)
})
it.each([['Open','Start investigating'],['Open','Monitor'],['Open','Resolve'],['Investigating','Monitor'],['Investigating','Resolve'],['Monitoring','Resume investigating'],['Monitoring','Resolve'],['Resolved','Reopen']] as const)('offers %s → %s',async(status,action)=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident(5,1,status));expect([...v.container.querySelectorAll('button')].some(b=>b.textContent===action)).toBe(true)
})
it.each(['Open','Investigating','Monitoring','Resolved'] as const)('submits a note in %s and refreshes from the server, never the receipt',async status=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident(5,8,status))
 await enterText(v.container,'Note','  Operator note  ');await clickButton(v.container,'Add note');const body=JSON.parse(f.requests[1].options!.body as string)
 expect(body).toMatchObject({expectedVersion:8,text:'Operator note'});expect(sessionStorage.getItem(workflowKey(5))).toContain(body.commandId)
 await f.requests[1].json({incidentId:5,commandId:body.commandId,version:9,event:{...makeIncidentEvent(9),commandId:body.commandId}})
 expect(v.container.querySelector('[data-incident-version]')?.textContent).toContain('8');await f.requests[2].json(makeIncident(5,10,status));expect(v.container.querySelector('[data-incident-version]')?.textContent).toContain('10')
 expect(v.container.querySelector<HTMLTextAreaElement>('#incident-note')?.value).toBe('')
})
it.each([['Open','Resolve','Resolution note'],['Resolved','Reopen','Reason for reopening']] as const)('requires a nonblank reason for %s %s',async(status,action,label)=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident(5,8,status));await clickButton(v.container,action)
 expect(v.container.querySelector<HTMLTextAreaElement>('#incident-transition-note')?.required).toBe(true)
 await enterText(v.container,label,'   ');await clickButton(v.container,'Save transition');expect(f.requests).toHaveLength(1)
 await enterText(v.container,label,'  Confirmed reason  ');await clickButton(v.container,'Save transition');expect(JSON.parse(f.requests[1].options!.body as string)).toMatchObject({note:'Confirmed reason',expectedVersion:8,status:status==='Open'?'Resolved':'Investigating'})
})
it('allows ordinary transitions with no explanatory note',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident());await clickButton(v.container,'Start investigating');await clickButton(v.container,'Save transition');expect(JSON.parse(f.requests[1].options!.body as string)).toMatchObject({status:'Investigating',note:null})
})
it('clears responder explicitly and disables editing when resolved',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json({...makeIncident(),responderLabel:'Team'});await enterText(v.container,'Responder / team','');await clickButton(v.container,'Save responder')
 expect(f.requests[1].options?.method).toBe('PUT');expect(JSON.parse(f.requests[1].options!.body as string).responderLabel).toBeNull()
 await v.rerender(<IncidentDetailPanel {...props} incidentId={8}/>);await f.requests[2].json(makeIncident(8,1,'Resolved'));expect(v.container.querySelector<HTMLInputElement>('#incident-responder')?.disabled).toBe(true)
})
it('restores a lost workflow response without auto-post and retries its exact original version',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident());await enterText(v.container,'Note','Retained');await clickButton(v.container,'Add note');const sent=f.requests[1].options!.body
 await f.requests[1].reject(new TypeError('lost'));await v.unmount();const next=await render(<IncidentDetailPanel {...props}/>);await f.requests[2].json(makeIncident(5,20));expect(f.requests).toHaveLength(3)
 expect(next.container.textContent).toContain('Previous incident action may have completed');await clickButton(next.container,'Retry same request');expect(f.requests[3].options!.body).toBe(sent)
})
it('ignores late timeline completion after latest refresh without releasing its guard',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json({...makeIncident(5,105),hasEarlierEvents:true,nextBeforeEventSequence:6});await clickButton(v.container,'Load earlier activity');await clickButton(v.container,'Refresh incident')
 expect(f.requests[1].signal?.aborted).toBe(true);await f.requests[1].json(makeIncident(5,106));expect(v.container.textContent).toContain('Loading incident')
 await f.requests[2].json(makeIncident(5,107));expect(v.container.querySelectorAll('[data-event-sequence]')).toHaveLength(1);expect(v.container.querySelector('[data-incident-version]')?.textContent).toContain('107')
})
it('does not replace a newer view or clear a new attempt from an obsolete mutation completion',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident());await enterText(v.container,'Note','Old');await clickButton(v.container,'Add note');const body=JSON.parse(f.requests[1].options!.body as string)
 await v.rerender(<IncidentDetailPanel {...props} incidentId={8}/>);await f.requests[2].json(makeIncident(8,22));await f.requests[1].json({incidentId:5,commandId:body.commandId,version:2,event:{...makeIncidentEvent(2),commandId:body.commandId}})
 expect(v.container.textContent).toContain('Incident 8');expect(f.requests).toHaveLength(3)
})
it.each(['state_conflict','command_conflict','responder_unchanged'])('keeps %s rejection reviewable without blind retry',async code=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json(makeIncident());await enterText(v.container,'Note','Keep draft');await clickButton(v.container,'Add note');await f.requests[1].json({title:'Rejected',code},409);await f.requests[2].json(makeIncident(5,2))
 expect(v.container.textContent).not.toContain('Previous incident action may have completed');expect(v.container.querySelector<HTMLTextAreaElement>('#incident-note')?.value).toBe('Keep draft')
 await clickButton(v.container,'Reviewed current state');await clickButton(v.container,'Add note');const old=JSON.parse(f.requests[1].options!.body as string),next=JSON.parse(f.requests[3].options!.body as string);expect(next.expectedVersion).toBe(2);expect(next.commandId).not.toBe(old.commandId)
})
it('shows missing current AP and offline null/zero evidence distinctly',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props} overview={{...makeOverview(),accessPoints:[]}}/>),d=makeIncident();Object.assign(d.monitoringEvidence.accessPoints[0],{operational:false,degraded:false,clients:0,channelUtilizationRatio:null,managementLatencySeconds:null,managementPacketLossRatio:null});await f.requests[0].json(d)
 expect(v.container.querySelector('[aria-labelledby="captured-heading"]')?.textContent).toContain('Unavailable');expect(v.container.querySelector('[aria-labelledby="captured-heading"]')?.textContent).toContain('Clients0');expect(v.container.querySelector('[aria-labelledby="current-network-heading"]')?.textContent).toContain('missing')
})
it('renders stored detail and actions without current monitoring',async()=>{
 const f=controlFetch(),v=await render(<IncidentDetailPanel {...props} overview={null} overviewError="Unavailable"/>);await f.requests[0].json(makeIncident());expect(v.container.textContent).toContain('Current monitoring unavailable');expect(v.container.querySelector<HTMLTextAreaElement>('#incident-note')?.disabled).toBe(false)
})
it('shows a scoped not-found state',async()=>{const f=controlFetch(),v=await render(<IncidentDetailPanel {...props}/>);await f.requests[0].json({title:'Incident not found'},404);expect(v.container.querySelector('h2')?.textContent).toBe('Incident not found')})
