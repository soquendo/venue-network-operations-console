// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { creationKey, workflowKey, readAttempt, saveAttempt, removeAttempt, discardAttempt, makeCreationAttempt, makeWorkflowAttempt, executeAttempt, scopeFromAccessPoints, defaultIncidentTitle } from './incidentRequestState'
import { makeAccessPoints } from './testUtils'
beforeEach(()=>sessionStorage.clear());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
function draft(){const aps=makeAccessPoints();aps[0].operational=false;return {scope:scopeFromAccessPoints(aps,'ap','ap-001')!,title:'  AP issue  ',responderLabel:'  Team  '}}
it('freezes only affected APs, with offline precedence and exact default titles',()=>{
 const aps=makeAccessPoints();aps[0].operational=false;aps[0].degraded=true;aps[1].degraded=true
 const scope=scopeFromAccessPoints(aps,'zone','zone-a')!
 expect(scope.accessPoints).toEqual([{apId:'ap-001',expectedCondition:'offline'},{apId:'ap-002',expectedCondition:'degraded'}])
 expect(defaultIncidentTitle(scope)).toBe('Zone A network condition')
 expect(defaultIncidentTitle(scopeFromAccessPoints(aps,'ap','ap-001')!)).toBe('ap-001 offline')
 aps[0].operational=true;expect(defaultIncidentTitle(scopeFromAccessPoints(aps,'zone','zone-a')!)).toBe('Zone A network degradation')
 expect(scope.accessPoints[0].expectedCondition).toBe('offline');expect(scopeFromAccessPoints(aps,'ap','ap-004')).toBeNull()
})
it('normalizes and persists immutable creation intent before dispatch',async()=>{
 const attempt=makeCreationAttempt(draft())
 vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>{expect(readAttempt(creationKey).attempt).toEqual(attempt);throw new TypeError('lost')}))
 await expect(executeAttempt(attempt)).rejects.toThrow();expect(readAttempt(creationKey).attempt?.payload).toMatchObject({title:'AP issue',responderLabel:'Team'})
})
it('retains the same exact payload for explicit transport retry',async()=>{
 const attempt=makeCreationAttempt(draft()),f=vi.fn().mockRejectedValue(new TypeError('lost'));vi.stubGlobal('fetch',f)
 await expect(executeAttempt(attempt)).rejects.toThrow();const restored=readAttempt(creationKey).attempt!
 await expect(executeAttempt(restored)).rejects.toThrow();expect(f.mock.calls[0][1].body).toBe(f.mock.calls[1][1].body)
})
it('prevents dispatch when session storage throws',async()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked')})
 await expect(executeAttempt(makeCreationAttempt(draft()))).rejects.toThrow();expect(f).not.toHaveBeenCalled()
})
it('rejects malformed records without executing and allows explicit discard',()=>{
 sessionStorage.setItem(creationKey,'{broken');expect(readAttempt(creationKey).error).toBeTruthy();expect(readAttempt(creationKey).attempt).toBeNull();discardAttempt(creationKey);expect(readAttempt(creationKey).error).toBeNull()
})
it('only clears an exactly matching attempt identity',()=>{
 const a=makeCreationAttempt(draft());saveAttempt(a);expect(removeAttempt(creationKey,crypto.randomUUID())).toBe(false);expect(readAttempt(creationKey).attempt).toEqual(a)
 expect(removeAttempt(creationKey,a.payload.creationCommandId)).toBe(true)
})
it('makes changed intent a fresh ID after review',()=>{
 const a=makeCreationAttempt(draft()),b=makeCreationAttempt({...draft(),title:'Different'})
 expect(a.payload.creationCommandId).not.toBe(b.payload.creationCommandId)
})
it('stores workflow identity/version and explicit null responder',()=>{
 const a=makeWorkflowAttempt(5,8,{kind:'responder',responderLabel:''});saveAttempt(a)
 expect(readAttempt(workflowKey(5)).attempt?.payload).toMatchObject({expectedVersion:8,responderLabel:null})
})
it('marks definitive rejection distinctly and forbids blind retry',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({title:'Changed',code:'condition_changed'}),{status:409})))
 await expect(executeAttempt(makeCreationAttempt(draft()))).rejects.toThrow()
 const a=readAttempt(creationKey).attempt!;expect(a.outcome).toBe('rejected');expect(a.problem?.code).toBe('condition_changed')
 const f=vi.fn();vi.stubGlobal('fetch',f);await expect(executeAttempt(a)).rejects.toThrow();expect(f).not.toHaveBeenCalled()
})
it.each(['note','transition','responder'] as const)('persists %s workflow before dispatch and keeps original version on loss',async kind=>{
 const intent=kind==='note'?{kind,text:' Note '}:kind==='transition'?{kind,status:'Monitoring' as const,note:''}:{kind,responderLabel:' Team '}
 const a=makeWorkflowAttempt(8,12,intent);vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>{expect(readAttempt(workflowKey(8)).attempt).toEqual(a);throw new Error('lost')}));await expect(executeAttempt(a)).rejects.toThrow();expect(readAttempt(workflowKey(8)).attempt?.payload).toMatchObject({expectedVersion:12})
})
it('refuses another unresolved intent for the same incident but allows another incident',()=>{
 const a=makeWorkflowAttempt(5,1,{kind:'note',text:'One'});saveAttempt(a);expect(()=>saveAttempt(makeWorkflowAttempt(5,1,{kind:'note',text:'Two'}))).toThrow();expect(()=>saveAttempt(makeWorkflowAttempt(8,1,{kind:'note',text:'Two'}))).not.toThrow()
})
it('keeps malformed successful mutation responses unknown for exact retry',async()=>{
 const a=makeCreationAttempt(draft());vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:201})));await expect(executeAttempt(a)).rejects.toThrow();expect(readAttempt(creationKey).attempt?.outcome).toBe('unknown')
})
it('rejects stored payloads that contain unmodeled telemetry',()=>{
 const a=makeCreationAttempt(draft());sessionStorage.setItem(creationKey,JSON.stringify({...a,payload:{...a.payload,clients:999}}));expect(readAttempt(creationKey).attempt).toBeNull();expect(readAttempt(creationKey).error).toBeTruthy()
})
