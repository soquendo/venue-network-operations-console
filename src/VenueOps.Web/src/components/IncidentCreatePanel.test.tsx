// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { IncidentCreatePanel } from './IncidentCreatePanel'
import { creationKey, scopeFromAccessPoints, makeCreationAttempt, saveAttempt } from '../incidentRequestState'
import { clickButton, controlFetch, enterText, makeAccessPoints, makeIncident, render, setupDomTests } from '../testUtils'
setupDomTests()
function draft(){const aps=makeAccessPoints();aps[0].operational=false;return {scope:scopeFromAccessPoints(aps,'ap','ap-001')!,title:'ap-001 offline',responderLabel:''}}
function props(){return {draft:draft(),onDraftChange:vi.fn(),onCreated:vi.fn(),onClose:vi.fn(),onConditionChanged:vi.fn(),onStartCurrent:vi.fn(),canCreate:true}}
it('sends frozen intent without telemetry and opens the created incident',async()=>{
 const f=controlFetch(),p=props(),v=await render(<IncidentCreatePanel {...p}/>);await clickButton(v.container,'Create incident')
 const body=JSON.parse(f.requests[0].options!.body as string);expect(body.accessPoints).toEqual([{apId:'ap-001',expectedCondition:'offline'}]);expect(Object.keys(body).sort()).toEqual(['accessPoints','creationCommandId','responderLabel','title'])
 expect(sessionStorage.getItem(creationKey)).toContain(body.creationCommandId)
 await f.requests[0].json(makeIncident(),201);expect(p.onCreated).toHaveBeenCalledWith(makeIncident());expect(sessionStorage.getItem(creationKey)).toBeNull()
})
it('restores unknown attempt without posting and explicitly retries exact payload',async()=>{
 const a=makeCreationAttempt(draft());saveAttempt(a);const f=controlFetch(),v=await render(<IncidentCreatePanel {...props()} draft={null}/>)
 expect(f.requests).toHaveLength(0);expect(v.container.textContent).toContain('Previous create attempt may have completed')
 await clickButton(v.container,'Retry same request');expect(JSON.parse(f.requests[0].options!.body as string)).toEqual(a.payload)
})
it('makes definitive changed-condition response review-only and refreshes monitoring',async()=>{
 const f=controlFetch(),p=props(),v=await render(<IncidentCreatePanel {...p}/>);await clickButton(v.container,'Create incident')
 await f.requests[0].json({title:'Changed',code:'condition_changed'},409)
 expect(p.onConditionChanged).toHaveBeenCalled();expect(v.container.textContent).toContain('Start new attempt from current condition');expect([...v.container.querySelectorAll('button')].some(b=>b.textContent==='Retry same request')).toBe(false)
})
it('does not redirect after unmount even if create settles successfully',async()=>{
 const f=controlFetch(),p=props(),v=await render(<IncidentCreatePanel {...p}/>);await clickButton(v.container,'Create incident');await v.unmount();await f.requests[0].json(makeIncident(),201);expect(p.onCreated).not.toHaveBeenCalled()
})
it('blocks mutation when retry storage fails',async()=>{
 const f=controlFetch();vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('denied')})
 const v=await render(<IncidentCreatePanel {...props()}/>);await clickButton(v.container,'Create incident');expect(f.requests).toHaveLength(0);expect(v.container.textContent).toContain('safe retry')
})
it('keeps editable title and responder separate from immutable submitted payload',async()=>{
 const f=controlFetch(),p=props(),v=await render(<IncidentCreatePanel {...p}/>);await enterText(v.container,'Title','Changed');expect(p.onDraftChange).toHaveBeenCalled()
 await clickButton(v.container,'Create incident');expect(JSON.parse(f.requests[0].options!.body as string).title).toBe('Changed')
})
it('blocks duplicate synchronous submission and keeps unknown outcomes retryable',async()=>{
 const f=controlFetch(),v=await render(<IncidentCreatePanel {...props()}/>);await clickButton(v.container,'Create incident');await clickButton(v.container,'Create incident');expect(f.requests).toHaveLength(1);await f.requests[0].reject(new TypeError('lost'));expect(v.container.textContent).toContain('Previous create attempt may have completed')
})
it('retains frozen scope when incoming monitoring-derived draft changes',async()=>{
 const f=controlFetch(),p=props(),v=await render(<IncidentCreatePanel {...p}/>);await v.rerender(<IncidentCreatePanel {...p} draft={{...p.draft,scope:{...p.draft.scope,accessPoints:[{apId:'ap-002',expectedCondition:'degraded'}]}}}/>);await clickButton(v.container,'Create incident');expect(JSON.parse(f.requests[0].options!.body as string).accessPoints).toEqual(p.draft.scope.accessPoints)
})
it('distinguishes creation key conflict from unknown completion',async()=>{
 const f=controlFetch(),v=await render(<IncidentCreatePanel {...props()}/>);await clickButton(v.container,'Create incident');await f.requests[0].json({title:'Key conflicts',code:'creation_command_conflict'},409);expect(v.container.textContent).toContain('Review and edit new attempt');expect(v.container.textContent).not.toContain('Previous create attempt may have completed')
})
it('permits saved keyed retry while fresh monitoring is unavailable',async()=>{
 const a=makeCreationAttempt(draft());saveAttempt(a);const f=controlFetch(),v=await render(<IncidentCreatePanel {...props()} canCreate={false}/>);await clickButton(v.container,'Retry same request');expect(JSON.parse(f.requests[0].options!.body as string)).toEqual(a.payload)
})
it('blocks fresh create while monitoring is unavailable',async()=>{const f=controlFetch(),v=await render(<IncidentCreatePanel {...props()} canCreate={false}/>);await clickButton(v.container,'Create incident');expect(f.requests).toHaveLength(0)})
it('enforces form bounds before dispatch',async()=>{
 const f=controlFetch(),v=await render(<IncidentCreatePanel {...props()}/>);await enterText(v.container,'Title','x'.repeat(201));await clickButton(v.container,'Create incident');expect(f.requests).toHaveLength(0)
 await enterText(v.container,'Title','Valid');await enterText(v.container,'Responder / team','x'.repeat(101));await clickButton(v.container,'Create incident');expect(f.requests).toHaveLength(0)
})
