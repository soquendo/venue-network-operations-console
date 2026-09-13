// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { IncidentListPanel } from './IncidentListPanel'
import { advanceTime, clickButton, controlFetch, makeIncidentSummary, render, setupDomTests } from '../testUtils'
setupDomTests()
const props={filters:{},onFiltersChange:vi.fn(),onOpen:vi.fn()}
it('renders empty bounded discovery without polling',async()=>{
 const f=controlFetch();const v=await render(<IncidentListPanel {...props}/>);await f.requests[0].json({items:[],hasMore:false,nextBeforeId:null})
 expect(v.container.textContent).toContain('No incidents');expect(f.requests[0].url).toBe('/api/incidents');await advanceTime(30_000);expect(f.requests).toHaveLength(1)
})
it('appends a matching cursor page and deduplicates identity',async()=>{
 const f=controlFetch();const v=await render(<IncidentListPanel {...props}/>);await f.requests[0].json({items:[makeIncidentSummary(5)],hasMore:true,nextBeforeId:5})
 await clickButton(v.container,'Load more');expect(f.requests[1].url).toBe('/api/incidents?beforeId=5')
 await f.requests[1].json({items:[makeIncidentSummary(5),makeIncidentSummary(4)],hasMore:false,nextBeforeId:null})
 expect(v.container.querySelectorAll('.incident-list-item')).toHaveLength(2)
})
it.each(['success','failure'])('isolates filter A→B→A from late %s',async outcome=>{
 const f=controlFetch();const v=await render(<IncidentListPanel {...props} filters={{status:'Open'}}/> )
 await v.rerender(<IncidentListPanel {...props} filters={{status:'Resolved'}}/> )
 await v.rerender(<IncidentListPanel {...props} filters={{status:'Open'}}/> )
 await f.requests[2].json({items:[makeIncidentSummary(9)],hasMore:false,nextBeforeId:null})
 if(outcome==='success')await f.requests[0].json({items:[makeIncidentSummary(1)],hasMore:false,nextBeforeId:null})
 else await f.requests[0].reject(new Error('old'))
 expect(v.container.textContent).toContain('INC-000009');expect(v.container.textContent).not.toContain('INC-000001');expect(v.container.querySelector('[role="alert"]')).toBeNull()
})
it('latest refresh rejects obsolete cursor success and retains data on current failure',async()=>{
 const f=controlFetch();const v=await render(<IncidentListPanel {...props}/>);await f.requests[0].json({items:[makeIncidentSummary(5)],hasMore:true,nextBeforeId:5})
 await clickButton(v.container,'Load more');await clickButton(v.container,'Refresh incidents')
 expect(f.requests[1].signal?.aborted).toBe(true)
 await f.requests[1].json({items:[makeIncidentSummary(1)],hasMore:false,nextBeforeId:null})
 await f.requests[2].json({title:'Incident storage is unavailable'},503)
 expect(v.container.textContent).toContain('INC-000005');expect(v.container.textContent).not.toContain('INC-000001');expect(v.container.textContent).toContain('Showing previously loaded incidents')
})
it('composes status/zone filters and clears old rows immediately on changed-filter failure',async()=>{
 const f=controlFetch(),v=await render(<IncidentListPanel {...props} filters={{status:'Open',zone:'zone-a'}}/>);expect(f.requests[0].url).toBe('/api/incidents?status=Open&zone=zone-a');await f.requests[0].json({items:[makeIncidentSummary(5)],hasMore:false,nextBeforeId:null})
 await v.rerender(<IncidentListPanel {...props} filters={{status:'Resolved',zone:'zone-b'}}/>);expect(v.container.textContent).not.toContain('INC-000005');await f.requests[1].json({title:'Incident storage is unavailable'},503);expect(v.container.textContent).not.toContain('INC-000005')
})
it('aborts unmounted discovery and ignores later completion',async()=>{
 const f=controlFetch(),v=await render(<IncidentListPanel {...props}/>);await v.unmount();expect(f.requests[0].signal?.aborted).toBe(true);await f.requests[0].json({items:[makeIncidentSummary(5)],hasMore:false,nextBeforeId:null})
})
