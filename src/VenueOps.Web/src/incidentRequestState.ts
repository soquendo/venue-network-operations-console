import { addIncidentNote, createIncident, IncidentApiError, positiveInteger, transitionIncident, updateIncidentResponder, validUuid, validateCreateRequest, validateWorkflowRequest,
  type CreateIncidentRequest, type IncidentDetail, type IncidentReceipt, type IncidentSelection, type IncidentStatus, type NoteRequest, type ResponderRequest, type TransitionRequest } from './api/incidents'
import type { AccessPointObservation } from './api/operations'

export const creationKey='venueops.incidentCreateAttempt.v1'
export const workflowKey=(id:number)=>`venueops.incidentAttempt.v1.${id}`
export interface CreationScope { entryPoint:'ap'|'zone'; target:string; zone:string; accessPoints:IncidentSelection[] }
export interface CreationDraft { scope:CreationScope; title:string; responderLabel:string }
export interface IncidentDraft { note:string; responderLabel:string|null; transitionStatus:IncidentStatus|null; transitionNote:string }
export const emptyIncidentDraft=():IncidentDraft=>({note:'',responderLabel:null,transitionStatus:null,transitionNote:''})
export interface AttemptProblem { status:number; title:string; detail?:string; code?:string; currentVersion?:number; currentStatus?:IncidentStatus }
interface AttemptBase { schema:1; outcome:'unknown'|'rejected'|'confirmed'; problem?:AttemptProblem }
export interface CreationAttempt extends AttemptBase { kind:'create'; scope:CreationScope; payload:CreateIncidentRequest & {creationCommandId:string} }
export type WorkflowAttempt = AttemptBase & ({kind:'note';incidentId:number;payload:NoteRequest}|{kind:'transition';incidentId:number;payload:TransitionRequest}|{kind:'responder';incidentId:number;payload:ResponderRequest})
export type IncidentAttempt=CreationAttempt|WorkflowAttempt
export type WorkflowIntent={kind:'note';text:string}|{kind:'transition';status:IncidentStatus;note:string}|{kind:'responder';responderLabel:string}
export const attemptId=(a:IncidentAttempt)=>a.kind==='create'?a.payload.creationCommandId:a.payload.commandId
export const attemptKey=(a:IncidentAttempt)=>a.kind==='create'?creationKey:workflowKey(a.incidentId)
export const displayZone=(zone:string)=>zone.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())
export function scopeFromAccessPoints(aps:AccessPointObservation[],entryPoint:'ap'|'zone',target:string):CreationScope|null {
  const selected=aps.filter(a=>(entryPoint==='ap'?a.apId===target:a.zone===target) && (!a.operational || a.degraded))
  if(!selected.length)return null
  const zone=selected[0].zone
  if(selected.some(a=>a.zone!==zone))return null
  return {entryPoint,target,zone,accessPoints:selected.map(a=>({apId:a.apId,expectedCondition:!a.operational?'offline' as const:'degraded' as const})).sort((a,b)=>a.apId<b.apId?-1:a.apId>b.apId?1:0)}
}
export function defaultIncidentTitle(scope:CreationScope){
  if(scope.accessPoints.length===1)return `${scope.accessPoints[0].apId} ${scope.accessPoints[0].expectedCondition}`
  return `${displayZone(scope.zone)} network ${scope.accessPoints.every(a=>a.expectedCondition==='degraded')?'degradation':'condition'}`
}
export function makeCreationAttempt(draft:CreationDraft):CreationAttempt {
  const payload={title:draft.title.trim(),responderLabel:draft.responderLabel.trim()||null,accessPoints:draft.scope.accessPoints.map(a=>({...a})),creationCommandId:crypto.randomUUID()}
  // Input limits apply before trimming, matching the server's validation boundary.
  validateCreateRequest({...payload,title:draft.title,responderLabel:draft.responderLabel})
  return {schema:1,outcome:'unknown',kind:'create',scope:structuredClone(draft.scope),payload}
}
export function makeWorkflowAttempt(incidentId:number,expectedVersion:number,intent:WorkflowIntent):WorkflowAttempt {
  if(!positiveInteger(incidentId))throw new IncidentApiError('validation',null,'Incident identity is invalid.')
  const base={schema:1 as const,outcome:'unknown' as const,incidentId},commandId=crypto.randomUUID()
  let attempt:WorkflowAttempt
  if(intent.kind==='note') {validateWorkflowRequest({commandId,expectedVersion,text:intent.text});attempt={...base,kind:'note',payload:{commandId,expectedVersion,text:intent.text.trim()}}}
  else if(intent.kind==='transition') {validateWorkflowRequest({commandId,expectedVersion,status:intent.status,note:intent.note});attempt={...base,kind:'transition',payload:{commandId,expectedVersion,status:intent.status,note:intent.note.trim()||null}}}
  else {validateWorkflowRequest({commandId,expectedVersion,responderLabel:intent.responderLabel});attempt={...base,kind:'responder',payload:{commandId,expectedVersion,responderLabel:intent.responderLabel.trim()||null}}}
  return attempt
}
const storageMessage='Unable to preserve a safe retry record in this browser session.'
export class IncidentStorageError extends Error { constructor(message=storageMessage){super(message);this.name='IncidentStorageError'} }
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object' && v!==null && !Array.isArray(v)
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k))
function validateAttempt(v:unknown,key:string):v is IncidentAttempt {
  try {
    if(!record(v) || !exact(v,['schema','outcome','kind','scope','payload','incidentId','problem']) || v.schema!==1 || !['unknown','rejected','confirmed'].includes(String(v.outcome)) || !record(v.payload))return false
    if(v.problem!==undefined && (!record(v.problem) || !exact(v.problem,['status','title','detail','code','currentVersion','currentStatus']) || typeof v.problem.title!=='string' || v.problem.title.length>200 || typeof v.problem.status!=='number' || JSON.stringify(v.problem).length>1800))return false
    if(v.kind==='create') {
      if(key!==creationKey || !record(v.scope) || !exact(v.scope,['entryPoint','target','zone','accessPoints']) || !['ap','zone'].includes(String(v.scope.entryPoint)) || typeof v.scope.target!=='string' || v.scope.target.length>64 || typeof v.scope.zone!=='string' || v.scope.zone.length>64 || !exact(v.payload,['title','responderLabel','accessPoints','creationCommandId']) || !validUuid(v.payload.creationCommandId))return false
      validateCreateRequest(v.payload as unknown as CreateIncidentRequest)
      if(JSON.stringify(v.scope.accessPoints)!==JSON.stringify(v.payload.accessPoints))return false
      if(!(v.payload.accessPoints as IncidentSelection[]).every(a=>exact(a as unknown as Record<string,unknown>,['apId','expectedCondition'])))return false
    } else {
      if(!positiveInteger(v.incidentId) || key!==workflowKey(v.incidentId) || !['note','transition','responder'].includes(String(v.kind)) || 'scope' in v)return false
      const keys=v.kind==='note'?['commandId','expectedVersion','text']:v.kind==='transition'?['commandId','expectedVersion','status','note']:['commandId','expectedVersion','responderLabel']
      if(!exact(v.payload,keys) || !keys.every(k=>k in (v.payload as object)))return false
      validateWorkflowRequest(v.payload as unknown as NoteRequest|TransitionRequest|ResponderRequest)
    }
    return true
  } catch {return false}
}
export function readAttempt(key:string):{attempt:IncidentAttempt|null;error:string|null} {
  try {
    const raw=sessionStorage.getItem(key)
    if(raw===null)return {attempt:null,error:null}
    if(raw.length>16384)throw new Error()
    const value:unknown=JSON.parse(raw)
    if(!validateAttempt(value,key))throw new Error()
    return {attempt:value,error:null}
  } catch {return {attempt:null,error:'The saved retry record is unavailable or invalid. Review it before discarding local state.'}}
}
export function saveAttempt(a:IncidentAttempt){
  const key=attemptKey(a)
  if(!validateAttempt(a,key))throw new IncidentStorageError('The retry record is invalid; no request was sent.')
  const prior=readAttempt(key)
  if(prior.error)throw new IncidentStorageError(prior.error)
  if(prior.attempt && (attemptId(prior.attempt)!==attemptId(a) || JSON.stringify(prior.attempt.payload)!==JSON.stringify(a.payload)))throw new IncidentStorageError('Review the previous attempt before starting another action.')
  try {const raw=JSON.stringify(a);sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw new Error()}
  catch {throw new IncidentStorageError()}
}
export function removeAttempt(key:string,id:string):boolean {
  const current=readAttempt(key)
  if(current.error)throw new IncidentStorageError(current.error)
  if(!current.attempt || attemptId(current.attempt)!==id)return false
  try {sessionStorage.removeItem(key);return true}catch{throw new IncidentStorageError()}
}
export function discardAttempt(key:string){try{sessionStorage.removeItem(key)}catch{throw new IncidentStorageError()}}
export const localErrorMessage=(e:unknown)=>e instanceof IncidentApiError || e instanceof IncidentStorageError?e.message:'The incident action could not be completed.'
export async function executeAttempt(a:IncidentAttempt,signal?:AbortSignal):Promise<{result:IncidentDetail|IncidentReceipt;cleanupError:string|null}> {
  if(a.outcome!=='unknown')throw new IncidentStorageError('This request was already answered. Review it before starting a new attempt.')
  saveAttempt(a)
  let result:IncidentDetail|IncidentReceipt
  try {
    if(a.kind==='create')result=await createIncident(a.payload,signal)
    else if(a.kind==='note')result=await addIncidentNote(a.incidentId,a.payload,signal)
    else if(a.kind==='transition')result=await transitionIncident(a.incidentId,a.payload,signal)
    else result=await updateIncidentResponder(a.incidentId,a.payload,signal)
  } catch(e) {
    if(e instanceof IncidentApiError && e.kind==='http' && [400,404,409,422].includes(e.status??0)) {
      const current=readAttempt(attemptKey(a)).attempt
      if(current && attemptId(current)===attemptId(a)) {
        const rejected:IncidentAttempt={...a,outcome:'rejected',problem:{status:e.status!,title:e.title,detail:e.detail,code:e.code,currentVersion:e.currentVersion,currentStatus:e.currentStatus}}
        try{saveAttempt(rejected)}catch{/* The known response still reaches the current UI; its draft is retained. */}
      }
    }
    throw e
  }
  // Confirmed commit and local cleanup are separate from any later detail GET.
  try {removeAttempt(attemptKey(a),attemptId(a));return {result,cleanupError:null}}
  catch(e) {
    try{saveAttempt({...a,outcome:'confirmed'})}catch{/* A restored exact retry remains safe if storage cannot be updated. */}
    return {result,cleanupError:localErrorMessage(e)}
  }
}
