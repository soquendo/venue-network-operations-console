import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getIncidentDetail, IncidentApiError, incidentErrorMessage, type IncidentAccessPoint, type IncidentDetail, type IncidentEvent, type IncidentStatus } from '../api/incidents'
import type { OperationsOverview, AccessPointObservation } from '../api/operations'
import { attemptId, discardAttempt, displayZone, emptyIncidentDraft, executeAttempt, localErrorMessage, makeWorkflowAttempt, readAttempt, removeAttempt, workflowKey, type IncidentDraft, type WorkflowAttempt, type WorkflowIntent } from '../incidentRequestState'

interface Props { incidentId:number; overview:OperationsOverview|null; overviewError:string|null; isOverviewLoading:boolean; drafts?:Map<number,IncidentDraft> }
const actions:Record<IncidentStatus,Array<{label:string;status:IncidentStatus}>>={
  Open:[{label:'Start investigating',status:'Investigating'},{label:'Monitor',status:'Monitoring'},{label:'Resolve',status:'Resolved'}],
  Investigating:[{label:'Monitor',status:'Monitoring'},{label:'Resolve',status:'Resolved'}],
  Monitoring:[{label:'Resume investigating',status:'Investigating'},{label:'Resolve',status:'Resolved'}],
  Resolved:[{label:'Reopen',status:'Investigating'}],
}
export function IncidentDetailPanel(props:Props){return <IncidentDetailContent key={props.incidentId} {...props}/>}
function IncidentDetailContent({incidentId,overview,overviewError,isOverviewLoading,drafts}:Props){
  const [localDrafts]=useState(()=>new Map<number,IncidentDraft>()),cache=drafts??localDrafts,key=workflowKey(incidentId)
  const [initial]=useState(()=>readAttempt(key))
  const [attempt,setAttempt]=useState<WorkflowAttempt|null>(initial.attempt?.kind!=='create'?initial.attempt as WorkflowAttempt|null:null)
  const [draft,setDraft]=useState<IncidentDraft>(()=>{
    const saved=cache.get(incidentId);if(saved)return saved
    const next=emptyIncidentDraft(),a=initial.attempt
    if(a?.kind==='note')next.note=a.payload.text
    if(a?.kind==='transition'){next.transitionStatus=a.payload.status;next.transitionNote=a.payload.note??''}
    if(a?.kind==='responder')next.responderLabel=a.payload.responderLabel??''
    cache.set(incidentId,next);return next
  })
  const [data,setData]=useState<IncidentDetail|null>(null),[error,setError]=useState<string|null>(null),[notFound,setNotFound]=useState(false)
  const [loading,setLoading]=useState(true),[fresh,setFresh]=useState(false),[busy,setBusy]=useState(false)
  const [actionError,setActionError]=useState<string|null>(initial.error),[storageIssue,setStorageIssue]=useState(initial.error!==null),[notice,setNotice]=useState<string|null>(null)
  const owner=useRef({active:false,request:null as AbortController|null,mutation:null as AbortController|null,generation:0})
  const dataRef=useRef<IncidentDetail|null>(null),heading=useRef<HTMLHeadingElement>(null),transitionInput=useRef<HTMLTextAreaElement>(null),actionOrigin=useRef<HTMLButtonElement|null>(null)
  const scrollAnchor=useRef<{element:Element;top:number}|null>(null)
  const updateDraft=(change:Partial<IncidentDraft>)=>{const next={...draft,...change};cache.set(incidentId,next);setDraft(next)}
  async function load(earlier=false,saved=false){
    const life=owner.current;if(!life.active || (earlier && life.request))return
    const cursor=earlier?dataRef.current?.nextBeforeEventSequence:undefined
    if(earlier && !cursor)return
    if(!earlier){life.generation++;life.request?.abort();setFresh(false)}
    const generation=life.generation,c=new AbortController();life.request=c
    const owns=()=>life.active && owner.current===life && generation===life.generation && life.request===c
    setLoading(true);setError(null)
    try {
      const result=await getIncidentDetail(incidentId,c.signal,cursor??undefined)
      if(owns()){
        if(earlier && dataRef.current){
          const current=dataRef.current,element=document.querySelector('[data-event-sequence]')
          if(element)scrollAnchor.current={element,top:element.getBoundingClientRect().top}
          const events=[...new Map([...result.events.filter(e=>e.sequence<cursor! && e.sequence<=current.version),...current.events].map(e=>[e.sequence,e])).values()].sort((a,b)=>a.sequence-b.sequence)
          const next={...current,events,hasEarlierEvents:result.hasEarlierEvents,nextBeforeEventSequence:result.nextBeforeEventSequence};dataRef.current=next;setData(next)
        }else{
          if(dataRef.current && result.version<dataRef.current.version)throw new IncidentApiError('response',200,'The latest incident response was older than the displayed state. Refresh again.')
          const next={...result,events:[...new Map(result.events.map(e=>[e.sequence,e])).values()].sort((a,b)=>a.sequence-b.sequence)}
          dataRef.current=next;setData(next);setFresh(true);setNotFound(false)
          if(saved)setNotice('Action was saved. Latest incident state refreshed.')
        }
      }
    }catch(e){if(owns()){
      if(!earlier && e instanceof IncidentApiError && e.status===404){setNotFound(true);dataRef.current=null;setData(null)}
      setError(saved?'Action was saved, but latest incident state could not be refreshed. '+incidentErrorMessage(e):incidentErrorMessage(e))
    }}finally{if(owns()){life.request=null;setLoading(false)}}
  }
  useEffect(()=>{
    const life={active:true,request:null as AbortController|null,mutation:null as AbortController|null,generation:0};owner.current=life;heading.current?.focus();void load()
    return ()=>{life.active=false;life.request?.abort();life.mutation?.abort()}
    // A new selected incident remounts this content; every effect setup owns its requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  useEffect(()=>{if(draft.transitionStatus)transitionInput.current?.focus()},[draft.transitionStatus])
  useLayoutEffect(()=>{const a=scrollAnchor.current;if(a?.element.isConnected){const delta=a.element.getBoundingClientRect().top-a.top;if(delta)window.scrollBy(0,delta)}scrollAnchor.current=null},[data?.events])
  async function submit(intent?:WorkflowIntent){
    const life=owner.current;if(!life.active || life.mutation || (intent && (!fresh || attempt || storageIssue)))return
    const c=new AbortController();life.mutation=c;setBusy(true);setActionError(null);setNotice(null)
    const owns=()=>life.active && owner.current===life && life.mutation===c
    const submittedDraft=draft
    try {
      const next=intent && dataRef.current?makeWorkflowAttempt(incidentId,dataRef.current.version,intent):attempt
      if(!next)return
      setAttempt(next)
      const {cleanupError}=await executeAttempt(next,c.signal)
      // Clear only this submitted draft, even if a later lifecycle has edited another one.
      if(cache.get(incidentId)===submittedDraft && !cleanupError){
        const cleared={...submittedDraft,...(next.kind==='note'?{note:''}:next.kind==='responder'?{responderLabel:null}:{transitionStatus:null,transitionNote:''})}
        cache.set(incidentId,cleared);if(owns())setDraft(cleared)
      }
      if(owns()){
        setAttempt(readAttempt(key).attempt as WorkflowAttempt|null)
        if(cleanupError){setStorageIssue(true);setActionError('Action was saved, but the local retry record could not be cleared. '+cleanupError)}
        setNotice('Action was saved. Refreshing latest incident state…')
        await load(false,true)
      }
    }catch(e){if(owns()){
      if(e instanceof IncidentApiError && e.kind==='http' && [400,404,409,422].includes(e.status??0)){
        setAttempt(previous=>previous?{...previous,outcome:'rejected',problem:{status:e.status!,title:e.title,detail:e.detail,code:e.code,currentVersion:e.currentVersion,currentStatus:e.currentStatus}}:null)
        setActionError(localErrorMessage(e));if(e.status===409)await load()
      }else{const stored=readAttempt(key);setAttempt(stored.attempt as WorkflowAttempt|null);setStorageIssue(stored.error!==null);setActionError(localErrorMessage(e))}
    }}finally{if(owns()){life.mutation=null;setBusy(false)}}
  }
  function review(discard=false){
    try{if(discard)discardAttempt(key);else if(attempt)removeAttempt(key,attemptId(attempt));setAttempt(null);setStorageIssue(false);setActionError(null);setNotice('Reviewed current state. Submit a new action when ready.')}
    catch(e){setActionError(localErrorMessage(e))}
  }
  const blocked=busy || !!attempt || storageIssue || !fresh || loading
  const available=data?actions[data.status]:[]
  const selectedAction=available.find(a=>a.status===draft.transitionStatus)
  const requiresNote=data?.status==='Resolved' || draft.transitionStatus==='Resolved'
  const noteLabel=draft.transitionStatus==='Resolved'?'Resolution note':data?.status==='Resolved'?'Reason for reopening':'Transition note (optional)'
  return <section className="section-block incident-panel" aria-labelledby="incident-detail-heading">
    <div className="section-heading"><h2 id="incident-detail-heading" ref={heading} tabIndex={-1}>{data?`${data.number} · ${data.title}`:notFound?'Incident not found':'Incident detail'}</h2><button type="button" onClick={()=>void load()}>Refresh incident</button></div>
    {loading && <p role="status">Loading incident…</p>}
    {error && <div className="error-banner" role="alert">{error}{data && ' Showing previously loaded incident data.'}</div>}
    {actionError && <div id="incident-action-error" className="error-banner" role="alert">{actionError}</div>}
    {notice && <p role="status">{notice}</p>}
    {attempt?.outcome==='unknown' && <div className="incident-notice"><p>Previous incident action may have completed.</p><p>{attemptDescription(attempt)}</p><button type="button" disabled={busy} onClick={()=>void submit()}>Retry same request</button></div>}
    {attempt?.outcome==='rejected' && <div className="incident-notice"><p>{conflictMessage(attempt.problem?.code)}</p>{data && <p>Current status: {data.status} · Version {data.version}</p>}<button type="button" disabled={!fresh || loading || busy} onClick={()=>review()}>Reviewed current state</button></div>}
    {(storageIssue || attempt?.outcome==='confirmed') && <div className="incident-notice"><p>Discarding a local retry record does not undo server changes. Review incident activity first.</p><button type="button" disabled={busy} onClick={()=>review(true)}>Discard local retry record</button></div>}
    {data && <>
      <section aria-labelledby="response-state-heading"><h3 id="response-state-heading">Current response state</h3><div className="incident-heading-state"><span className="incident-status">{data.status}</span><span data-incident-version={data.version}>Version {data.version}</span></div><dl className="incident-facts"><div><dt>Zone</dt><dd>{displayZone(data.zone)}</dd></div><div><dt>Responder / team</dt><dd>{data.responderLabel??'Not set'}</dd></div><div><dt>Created</dt><dd><Timestamp value={data.createdAtUtc}/></dd></div>{data.resolvedAtUtc && <div><dt>Resolved</dt><dd><Timestamp value={data.resolvedAtUtc}/></dd></div>}</dl></section>
      <section className="incident-evidence" aria-labelledby="captured-heading"><h3 id="captured-heading">Captured at incident creation</h3><p>Why this incident was opened. This evidence does not change when monitoring recovers.</p><p>Captured: <Timestamp value={data.monitoringEvidence.capturedAtUtc}/> · Monitoring response generated: <Timestamp value={data.monitoringEvidence.generatedAtUtc}/></p>{data.monitoringEvidence.accessPoints.map(ap=><article className="incident-ap" key={ap.apId}><h4>{ap.apId}</h4><Measurements ap={ap}/><p>Source: {ap.source} · Observed: <Timestamp value={ap.observedAtUtc}/></p><p>Captured AP-down state: {ap.alertState} · Captured degradation state: {ap.degradationAlertState}</p>{(['downAlert','degradationAlert'] as const).map(field=><div key={field}><strong>{field==='downAlert'?'AP-down occurrence':'Degradation occurrence'}: </strong>{ap[field]?<span>{ap[field].name} · {ap[field].state} · {ap[field].severity} · {ap[field].telemetrySource} · {ap[field].apId} / {ap[field].zone} · <Timestamp value={ap[field].observedAtUtc}/></span>:<span>No active occurrence captured</span>}</div>)}</article>)}</section>
      <section className="incident-current" aria-labelledby="current-network-heading"><h3 id="current-network-heading">Current network state</h3><p>What monitoring shows now; separate from the saved incident evidence.</p>{overviewError && <p role="status">{overview?'Retained/stale telemetry. ':''}{overviewError}</p>}{overview?<><p>{overviewError?'Last successful response generated':'Response generated'}: <Timestamp value={overview.generatedAtUtc}/>{isOverviewLoading?' · Refreshing telemetry…':''}</p>{data.monitoringEvidence.accessPoints.map(captured=>{const current=overview.accessPoints.find(a=>a.apId===captured.apId);return <article className="incident-ap" key={captured.apId}><h4>{captured.apId}</h4>{current?<Measurements ap={current}/>:<p>Unavailable — this AP is missing from the current response.</p>}</article>})}</>:<p>Current monitoring unavailable. Stored incident evidence and response actions remain independent.</p>}</section>
      <section aria-labelledby="incident-activity-heading"><h3 id="incident-activity-heading">Activity and response</h3>
        <div className="incident-actions">{available.map(action=><button key={action.label} type="button" disabled={blocked} onClick={e=>{actionOrigin.current=e.currentTarget;updateDraft({transitionStatus:action.status});}}>{action.label}</button>)}</div>
        {draft.transitionStatus && <form onSubmit={e=>{e.preventDefault();if(!blocked && selectedAction && (!requiresNote || draft.transitionNote.trim()))void submit({kind:'transition',status:draft.transitionStatus!,note:draft.transitionNote})}} aria-describedby={actionError?'incident-action-error':undefined}>
          {!selectedAction && <p>This drafted transition is no longer available from the current state. Choose an available action after review.</p>}
          <label htmlFor="incident-transition-note">{noteLabel}</label><textarea ref={transitionInput} id="incident-transition-note" maxLength={2000} required={requiresNote} disabled={blocked} value={draft.transitionNote} onChange={e=>updateDraft({transitionNote:e.target.value})}/>
          <div className="incident-actions"><button type="submit" disabled={blocked || !selectedAction || (requiresNote && !draft.transitionNote.trim()) || draft.transitionNote.length>2000}>Save transition</button><button type="button" disabled={busy} onClick={()=>{updateDraft({transitionStatus:null});actionOrigin.current?.focus()}}>Cancel transition</button></div>
        </form>}
        <form onSubmit={e=>{e.preventDefault();if(!blocked && draft.note.trim())void submit({kind:'note',text:draft.note})}} aria-describedby={actionError?'incident-action-error':undefined}><label htmlFor="incident-note">Note</label><textarea id="incident-note" maxLength={2000} required disabled={blocked} value={draft.note} onChange={e=>updateDraft({note:e.target.value})}/><button type="submit" disabled={blocked || !draft.note.trim() || draft.note.length>2000}>Add note</button></form>
        <form onSubmit={e=>{e.preventDefault();if(!blocked && data.status!=='Resolved')void submit({kind:'responder',responderLabel:draft.responderLabel??data.responderLabel??''})}} aria-describedby="incident-responder-help"><label htmlFor="incident-responder">Responder / team</label><input id="incident-responder" maxLength={100} disabled={blocked || data.status==='Resolved'} value={draft.responderLabel??data.responderLabel??''} onChange={e=>updateDraft({responderLabel:e.target.value})}/><p id="incident-responder-help" className="incident-muted">Manually entered operational label; not authenticated assignment. Clear the field to remove the label.{data.status==='Resolved'?' Reopen before changing it.':''}</p><button type="submit" disabled={blocked || data.status==='Resolved' || (draft.responderLabel??'').length>100}>Save responder</button></form>
        {data.hasEarlierEvents && <button type="button" disabled={loading || !fresh} onClick={()=>void load(true)}>Load earlier activity</button>}
        <ol className="incident-timeline" aria-label="Incident activity">{data.events.map(event=><li key={event.sequence} data-event-sequence={event.sequence}><strong>{eventLabel(event)}</strong><Timestamp value={event.occurredAtUtc}/>{event.text && <p>{event.text}</p>}</li>)}</ol>
      </section>
    </>}
  </section>
}
function Timestamp({value}:{value:string}){return <time dateTime={value}>{new Date(value).toLocaleString()}</time>}
function Measurements({ap}:{ap:AccessPointObservation|IncidentAccessPoint}){
  const state=!ap.operational?'Offline':ap.degraded?'Degraded':'Healthy'
  const percent=(v:number|null)=>v===null?'Unavailable':`${(v*100).toFixed(1)}%`
  return <dl className="incident-facts"><div><dt>Status</dt><dd><span className={`status-badge status-${state.toLowerCase()}`}>{state}</span></dd></div><div><dt>Operational</dt><dd>{ap.operational?'Yes':'No'}</dd></div><div><dt>Clients</dt><dd>{ap.clients}</dd></div><div><dt>Channel use</dt><dd>{percent(ap.channelUtilizationRatio)}</dd></div><div><dt>Management latency</dt><dd>{ap.managementLatencySeconds===null?'Unavailable':`${(ap.managementLatencySeconds*1000).toFixed(1)} ms`}</dd></div><div><dt>Management loss</dt><dd>{percent(ap.managementPacketLossRatio)}</dd></div></dl>
}
function eventLabel(e:IncidentEvent){if(e.kind==='Created')return 'Incident created';if(e.kind==='NoteAdded')return 'Note added';if(e.kind==='ResponderChanged')return `Responder / team changed from ${e.previousResponderLabel??'Not set'} to ${e.responderLabel??'Not set'}`;return `${e.fromStatus} → ${e.toStatus}`}
function attemptDescription(a:WorkflowAttempt){return a.kind==='note'?`Add note: ${a.payload.text}`:a.kind==='responder'?`Responder / team: ${a.payload.responderLabel??'Not set'}`:`Status → ${a.payload.status}${a.payload.note?': '+a.payload.note:''}`}
function conflictMessage(code?:string){switch(code){case 'version_conflict':return 'Another change occurred. Review the latest incident state before submitting a new action.';case 'state_conflict':return 'This action no longer fits the incident state. Review the available actions.';case 'command_conflict':return 'The retry key belongs to a different committed action. Review before creating a new request.';case 'responder_unchanged':return 'The responder / team label is unchanged.';default:return 'This action was rejected. Review the draft and current state before submitting again.'}}
