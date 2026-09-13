// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addIncidentNote, createIncident, getIncidentDetail, IncidentApiError, listIncidents, transitionIncident, updateIncidentResponder } from './incidents'
const key='66ab97eb-7a85-4b62-872c-f4bec41e9ae1'
afterEach(()=>vi.unstubAllGlobals())
function response(body:unknown,status=200) { const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status}));vi.stubGlobal('fetch',fetch);return fetch }
const detail={id:5,number:'INC-000005',title:'Issue',zone:'zone-a',status:'Open',responderLabel:null,createdAtUtc:'2026-09-13T00:00:00Z',resolvedAtUtc:null,version:1,monitoringEvidence:{capturedAtUtc:'2026-09-13T00:00:00Z',generatedAtUtc:'2026-09-13T00:00:00Z',accessPoints:[]},events:[],hasEarlierEvents:false,nextBeforeEventSequence:null}
const receipt={incidentId:5,commandId:key,version:2,event:{id:2,kind:'NoteAdded',sequence:2,commandId:key,occurredAtUtc:'2026-09-13T00:00:00Z',text:'Note',fromStatus:null,toStatus:null,previousResponderLabel:null,responderLabel:null}}
describe('incident API contracts',()=>{
 it('sends only caller creation intent and preserves the key',async()=>{
  const f=response(detail,201),body={title:'Issue',responderLabel:null,accessPoints:[{apId:'ap-001',expectedCondition:'offline' as const}],creationCommandId:key}
  expect(await createIncident(body)).toEqual(detail)
  expect(f).toHaveBeenCalledTimes(1);expect(f.mock.calls[0][0]).toBe('/api/incidents')
  expect(f.mock.calls[0][1].method).toBe('POST');expect(JSON.parse(f.mock.calls[0][1].body)).toEqual(body)
 })
 it('encodes list filters/cursor and forwards cancellation',async()=>{
  const f=response({items:[],hasMore:false,nextBeforeId:null}),c=new AbortController()
  await listIncidents({status:'Open',zone:'zone a',beforeId:123},c.signal)
  expect(f.mock.calls[0][0]).toBe('/api/incidents?status=Open&zone=zone+a&beforeId=123');expect(f.mock.calls[0][1].signal).toBe(c.signal)
 })
 it('encodes earlier timeline and forwards signal',async()=>{
  const f=response(detail),c=new AbortController();await getIncidentDetail(5,c.signal,10)
  expect(f.mock.calls[0][0]).toBe('/api/incidents/5?beforeEventSequence=10');expect(f.mock.calls[0][1].signal).toBe(c.signal)
 })
 it.each(['note','transition','responder'])('sends exact %s command without rewriting version',async kind=>{
  const f=response(receipt);let body:object
  if(kind==='note'){body={commandId:key,expectedVersion:1,text:'Note'};await addIncidentNote(5,body as never)}
  else if(kind==='transition'){body={commandId:key,expectedVersion:1,status:'Resolved',note:'Recovered'};await transitionIncident(5,body as never)}
  else {body={commandId:key,expectedVersion:1,responderLabel:null};await updateIncidentResponder(5,body as never)}
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual(body);expect(f.mock.calls[0][1].method).toBe(kind==='responder'?'PUT':'POST')
  expect(f.mock.calls[0][0]).toBe('/api/incidents/5/'+({note:'notes',transition:'transitions',responder:'responder'}[kind]));expect(f).toHaveBeenCalledTimes(1)
 })
 it('decodes bounded stable conflict metadata',async()=>{
  response({title:'Incident changed',detail:'Review',code:'version_conflict',currentVersion:9,currentStatus:'Resolved'},409)
  await expect(getIncidentDetail(5)).rejects.toMatchObject({status:409,title:'Incident changed',detail:'Review',code:'version_conflict',currentVersion:9,currentStatus:'Resolved',kind:'http'})
 })
 it('does not expose an HTML error body',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html>private stack</html>',{status:503})))
  await expect(listIncidents({})).rejects.toMatchObject({status:503,kind:'http'})
  try{await listIncidents({})}catch(e){expect((e as Error).message).not.toContain('private stack')}
 })
 it('bounds server text',async()=>{
  response({title:'t'.repeat(1000),detail:'d'.repeat(10000)},400)
  try{await listIncidents({})}catch(e){expect(e).toBeInstanceOf(IncidentApiError);expect((e as Error).message.length).toBeLessThan(1500)}
 })
 it('distinguishes transport failure without exposing exception text',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('private internal string')))
  await expect(listIncidents({})).rejects.toMatchObject({kind:'transport',status:null})
 })
 it('treats malformed successful JSON as uncertain response',async()=>{
  response({wrong:true},201);await expect(createIncident({title:'Issue',accessPoints:[{apId:'ap-001',expectedCondition:'offline'}],creationCommandId:key,responderLabel:null})).rejects.toMatchObject({kind:'response'})
 })
 it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects unsafe identity %s before fetch',async id=>{
  const f=response(detail);await expect(getIncidentDetail(id)).rejects.toBeInstanceOf(IncidentApiError);expect(f).not.toHaveBeenCalled()
 })
 it('rejects unsafe response versions',async()=>{response({...detail,version:Number.MAX_SAFE_INTEGER+1});await expect(getIncidentDetail(5)).rejects.toMatchObject({kind:'response'})})
})
