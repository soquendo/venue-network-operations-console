import type { AccessPointObservation, TelemetrySource, AlertState } from './operations'

export const incidentStatuses = ['Open', 'Investigating', 'Monitoring', 'Resolved'] as const
export type IncidentStatus = typeof incidentStatuses[number]
export interface IncidentSelection { apId: string; expectedCondition: 'offline' | 'degraded' }
export interface CreateIncidentRequest { title: string; responderLabel: string | null; accessPoints: IncidentSelection[]; creationCommandId?: string | null }
export interface IncidentAlert { name: string; state: AlertState; severity: string; telemetrySource: TelemetrySource; apId: string; zone: string; observedAtUtc: string }
export interface IncidentAccessPoint extends AccessPointObservation { downAlert: IncidentAlert | null; degradationAlert: IncidentAlert | null }
export interface IncidentEvent { id: number; kind: 'Created' | 'NoteAdded' | 'StatusChanged' | 'ResponderChanged'; occurredAtUtc: string; sequence: number; commandId: string | null; text: string | null; fromStatus: IncidentStatus | null; toStatus: IncidentStatus | null; previousResponderLabel: string | null; responderLabel: string | null }
export interface IncidentSummary { id: number; number: string; title: string; status: IncidentStatus; zone: string; responderLabel: string | null; createdAtUtc: string; resolvedAtUtc: string | null; version: number; affectedAccessPointCount: number }
export interface IncidentDetail extends Omit<IncidentSummary, 'affectedAccessPointCount'> { monitoringEvidence: { capturedAtUtc: string; generatedAtUtc: string; accessPoints: IncidentAccessPoint[] }; events: IncidentEvent[]; hasEarlierEvents: boolean; nextBeforeEventSequence: number | null }
export interface IncidentList { items: IncidentSummary[]; hasMore: boolean; nextBeforeId: number | null }
export interface IncidentFilters { status?: IncidentStatus; zone?: string }
export interface IncidentListQuery extends IncidentFilters { beforeId?: number }
export interface NoteRequest { commandId: string; expectedVersion: number; text: string }
export interface TransitionRequest { commandId: string; expectedVersion: number; status: IncidentStatus; note: string | null }
export interface ResponderRequest { commandId: string; expectedVersion: number; responderLabel: string | null }
export interface IncidentReceipt { incidentId: number; commandId: string; version: number; event: IncidentEvent }
export type IncidentErrorKind = 'http' | 'transport' | 'response' | 'validation'

export class IncidentApiError extends Error {
  kind: IncidentErrorKind
  status: number | null
  title: string
  detail?: string
  code?: string
  currentVersion?: number
  currentStatus?: IncidentStatus
  constructor(kind: IncidentErrorKind, status: number | null, title: string,
    detail?: string, code?: string, currentVersion?: number, currentStatus?: IncidentStatus) {
    super(detail ? `${title} ${detail}` : title)
    this.name = 'IncidentApiError'
    this.kind=kind; this.status=status; this.title=title; this.detail=detail; this.code=code; this.currentVersion=currentVersion; this.currentStatus=currentStatus
  }
}
export const isIncidentStatus = (value: unknown): value is IncidentStatus => incidentStatuses.some(s => s === value)
export const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export const validUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
const nullableText = (value: unknown, max: number) => value === null || text(value, max)
const date = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const cursor = (value: unknown) => value === null || positiveInteger(value)
function requireInput(ok: boolean, message: string): asserts ok { if (!ok) throw new IncidentApiError('validation', null, message) }
export function validateCreateRequest(value: CreateIncidentRequest) {
  requireInput(text(value.title, 200) && value.title.trim().length > 0, 'Title must contain 1–200 characters.')
  requireInput(nullableText(value.responderLabel, 100), 'Responder / team must not exceed 100 characters.')
  requireInput(value.creationCommandId == null || validUuid(value.creationCommandId), 'Creation command ID must be a non-empty UUID.')
  requireInput(Array.isArray(value.accessPoints) && value.accessPoints.length >= 1 && value.accessPoints.length <= 4, 'Select between one and four access points.')
  requireInput(value.accessPoints.every(a => object(a) && text(a.apId,64) && a.apId.trim().length > 0 && ['offline','degraded'].includes(a.expectedCondition)) && new Set(value.accessPoints.map(a=>a.apId)).size === value.accessPoints.length, 'Access point selections must be valid and unique.')
}
export function validateWorkflowRequest(value: NoteRequest | TransitionRequest | ResponderRequest) {
  requireInput(validUuid(value.commandId) && positiveInteger(value.expectedVersion), 'Command identity and version must be valid.')
  if ('text' in value) requireInput(text(value.text,2000) && value.text.trim().length > 0, 'Note must contain 1–2,000 characters.')
  if ('note' in value) requireInput(isIncidentStatus(value.status) && nullableText(value.note,2000), 'Transition note must not exceed 2,000 characters.')
  if ('responderLabel' in value) requireInput(nullableText(value.responderLabel,100), 'Responder / team must not exceed 100 characters.')
}
function validHeader(v: unknown): v is Record<string, unknown> {
  return object(v) && positiveInteger(v.id) && positiveInteger(v.version) && text(v.number,40) && text(v.title,200) && text(v.zone,64) && isIncidentStatus(v.status) && nullableText(v.responderLabel,100) && date(v.createdAtUtc) && (v.resolvedAtUtc === null || date(v.resolvedAtUtc))
}
function validEvent(v: unknown): boolean {
  return object(v) && positiveInteger(v.id) && positiveInteger(v.sequence) && ['Created','NoteAdded','StatusChanged','ResponderChanged'].includes(String(v.kind)) && date(v.occurredAtUtc) && (v.commandId === null || validUuid(v.commandId)) && nullableText(v.text,2000) && (v.fromStatus===null || isIncidentStatus(v.fromStatus)) && (v.toStatus===null || isIncidentStatus(v.toStatus)) && nullableText(v.previousResponderLabel,100) && nullableText(v.responderLabel,100)
}
function validAlert(v: unknown): boolean {
  return v === null || (object(v) && text(v.name,100) && ['pending','firing'].includes(String(v.state)) && text(v.severity,64) && text(v.telemetrySource,64) && text(v.apId,64) && text(v.zone,64) && date(v.observedAtUtc))
}
function validAp(v: unknown): boolean {
  return object(v) && text(v.apId,64) && text(v.zone,64) && typeof v.operational==='boolean' && typeof v.degraded==='boolean' && Number.isSafeInteger(v.clients) && Number(v.clients)>=0 && ['channelUtilizationRatio','managementLatencySeconds','managementPacketLossRatio'].every(k=>v[k]===null || (typeof v[k]==='number' && Number.isFinite(v[k]))) && ['inactive','pending','firing'].includes(String(v.alertState)) && ['inactive','pending','firing'].includes(String(v.degradationAlertState)) && ['simulated','measured','derived'].includes(String(v.source)) && date(v.observedAtUtc) && validAlert(v.downAlert) && validAlert(v.degradationAlert)
}
function validDetail(v: unknown): boolean {
  if (!validHeader(v) || !object(v.monitoringEvidence)) return false
  const e=v.monitoringEvidence
  return date(e.capturedAtUtc) && date(e.generatedAtUtc) && Array.isArray(e.accessPoints) && e.accessPoints.length<=4 && e.accessPoints.every(validAp) && Array.isArray(v.events) && v.events.length<=100 && v.events.every(validEvent) && typeof v.hasEarlierEvents==='boolean' && cursor(v.nextBeforeEventSequence) && (!v.hasEarlierEvents || positiveInteger(v.nextBeforeEventSequence))
}
function validList(v: unknown): boolean {
  return object(v) && Array.isArray(v.items) && v.items.length<=50 && v.items.every(i=>validHeader(i) && Number.isSafeInteger(i.affectedAccessPointCount) && Number(i.affectedAccessPointCount)>=0) && typeof v.hasMore==='boolean' && cursor(v.nextBeforeId) && (!v.hasMore || positiveInteger(v.nextBeforeId))
}
function validReceipt(v: unknown): boolean {
  return object(v) && positiveInteger(v.incidentId) && validUuid(v.commandId) && positiveInteger(v.version) && validEvent(v.event) && object(v.event) && v.event.sequence===v.version && v.event.commandId===v.commandId
}
const bounded = (v: unknown, limit: number) => typeof v === 'string' && v.trim() ? v.slice(0,limit) : undefined
async function request<T>(path: string, options: RequestInit, validate: (v: unknown)=>boolean, expectedStatus=200): Promise<T> {
  let response: Response
  try { response=await fetch(path,{...options,headers:{Accept:'application/json',...(options.body ? {'Content-Type':'application/json'} : {})},cache:'no-store'}) }
  catch { throw new IncidentApiError('transport',null,'The incident request could not be completed. Its outcome may be unknown.') }
  if (!response.ok) {
    let p:Record<string,unknown>={}
    try { const value:unknown=await response.json();if(object(value))p=value } catch { /* HTTP status still identifies the failure. */ }
    throw new IncidentApiError('http',response.status,bounded(p.title,200) ?? `The incident API returned HTTP ${response.status}.`,bounded(p.detail,1000),bounded(p.code,80),positiveInteger(p.currentVersion)?p.currentVersion:undefined,isIncidentStatus(p.currentStatus)?p.currentStatus:undefined)
  }
  let body:unknown
  try { body=await response.json() } catch { throw new IncidentApiError('response',response.status,'The incident API returned an unreadable response. The request outcome may be unknown.') }
  if(response.status!==expectedStatus || !validate(body))throw new IncidentApiError('response',response.status,'The incident API returned an unsupported response or unsafe numeric identity. The request outcome may be unknown.')
  return body as T
}
const idPath=(id:number)=>{requireInput(positiveInteger(id),'Incident ID must be a positive safe integer.');return `/api/incidents/${id}`}
export async function createIncident(body:CreateIncidentRequest,signal?:AbortSignal):Promise<IncidentDetail>{validateCreateRequest(body);return request('/api/incidents',{method:'POST',body:JSON.stringify(body),signal},validDetail,201)}
export async function listIncidents(query:IncidentListQuery,signal?:AbortSignal):Promise<IncidentList>{
  const p=new URLSearchParams()
  if(query.status!==undefined){requireInput(isIncidentStatus(query.status),'Invalid status filter.');p.set('status',query.status)}
  if(query.zone!==undefined){requireInput(query.zone.trim().length>0 && query.zone.length<=64 && !query.zone.includes('\0'),'Invalid zone filter.');p.set('zone',query.zone)}
  if(query.beforeId!==undefined){requireInput(positiveInteger(query.beforeId),'Before ID must be a positive safe integer.');p.set('beforeId',String(query.beforeId))}
  return request('/api/incidents'+(p.size?'?'+p:''),{signal},validList)
}
export async function getIncidentDetail(id:number,signal?:AbortSignal,beforeEventSequence?:number):Promise<IncidentDetail>{
  let path=idPath(id)
  if(beforeEventSequence!==undefined){requireInput(positiveInteger(beforeEventSequence),'Before event sequence must be a positive safe integer.');path+='?'+new URLSearchParams({beforeEventSequence:String(beforeEventSequence)})}
  const result=await request<IncidentDetail>(path,{signal},validDetail)
  if(result.id!==id)throw new IncidentApiError('response',200,'The incident response identity did not match the request.')
  return result
}
async function command(id:number,action:string,body:NoteRequest|TransitionRequest|ResponderRequest,signal?:AbortSignal):Promise<IncidentReceipt>{
  const path=idPath(id);validateWorkflowRequest(body)
  const r=await request<IncidentReceipt>(path+'/'+action,{method:action==='responder'?'PUT':'POST',body:JSON.stringify(body),signal},validReceipt)
  if(r.incidentId!==id || r.commandId!==body.commandId)throw new IncidentApiError('response',200,'The command receipt identity did not match the request.')
  return r
}
export const addIncidentNote=(id:number,body:NoteRequest,signal?:AbortSignal)=>command(id,'notes',body,signal)
export const transitionIncident=(id:number,body:TransitionRequest,signal?:AbortSignal)=>command(id,'transitions',body,signal)
export const updateIncidentResponder=(id:number,body:ResponderRequest,signal?:AbortSignal)=>command(id,'responder',body,signal)
export const incidentErrorMessage=(error:unknown)=>error instanceof IncidentApiError ? error.message : 'The incident request could not be completed.'
