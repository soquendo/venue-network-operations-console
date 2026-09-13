import { useEffect, useRef, useState } from 'react'
import { IncidentApiError, type IncidentDetail } from '../api/incidents'
import { creationKey, discardAttempt, displayZone, executeAttempt, localErrorMessage, makeCreationAttempt, readAttempt, type CreationAttempt, type CreationDraft } from '../incidentRequestState'
interface Props { draft:CreationDraft|null; onDraftChange:(draft:CreationDraft)=>void; onCreated:(incident:IncidentDetail)=>void; onClose:()=>void; onConditionChanged:()=>void; onStartCurrent:()=>void; canCreate:boolean }
export function IncidentCreatePanel(props:Props){
  const [initial]=useState(()=>readAttempt(creationKey))
  const [attempt,setAttempt]=useState<CreationAttempt|null>(initial.attempt?.kind==='create'?initial.attempt:null)
  const [draft,setDraft]=useState<CreationDraft|null>(()=>props.draft ?? (initial.attempt?.kind==='create'?{scope:initial.attempt.scope,title:initial.attempt.payload.title,responderLabel:initial.attempt.payload.responderLabel??''}:null))
  const [error,setError]=useState<string|null>(initial.error),[busy,setBusy]=useState(false),[storageIssue,setStorageIssue]=useState(initial.error!==null)
  const owner=useRef<{active:boolean;request:AbortController|null}>({active:false,request:null}),heading=useRef<HTMLHeadingElement>(null)
  useEffect(()=>{const life={active:true,request:null as AbortController|null};owner.current=life;heading.current?.focus();return()=>{life.active=false;life.request?.abort()}},[])
  const update=(change:Partial<CreationDraft>)=>{if(!draft)return;const next={...draft,...change};setDraft(next);props.onDraftChange(next)}
  async function submit(retry=false){
    const life=owner.current;if(!life.active || life.request)return
    const c=new AbortController();life.request=c;setBusy(true);setError(null)
    const owns=()=>life.active && owner.current===life && life.request===c
    try {
      const next=retry?attempt: draft?makeCreationAttempt(draft):null
      if(!next)return
      setAttempt(next)
      const {result,cleanupError}=await executeAttempt(next,c.signal)
      if(owns()){
        setAttempt(readAttempt(creationKey).attempt as CreationAttempt|null)
        if(cleanupError){setError('Incident was created, but its local retry record could not be cleared. '+cleanupError);setStorageIssue(true)}
        else props.onCreated(result as IncidentDetail)
      }
    } catch(e){if(owns()){
      const stored=readAttempt(creationKey)
      if(e instanceof IncidentApiError && e.kind==='http' && [400,404,409,422].includes(e.status??0)) {
        setAttempt(previous=>previous?{...previous,outcome:'rejected',problem:{status:e.status!,title:e.title,detail:e.detail,code:e.code}}:null)
        if(e.code==='condition_changed')props.onConditionChanged()
      }else setAttempt(stored.attempt as CreationAttempt|null)
      setError(localErrorMessage(e));setStorageIssue(stored.error!==null)
    }}finally{if(owns()){life.request=null;setBusy(false)}}
  }
  function discard(startCurrent=false){
    try{discardAttempt(creationKey);setAttempt(null);setError(null);setStorageIssue(false);if(startCurrent)props.onStartCurrent()}
    catch(e){setError(localErrorMessage(e))}
  }
  const frozen=attempt?.scope??draft?.scope,locked=busy || attempt!==null || storageIssue
  const rejection=attempt?.outcome==='rejected',unknown=attempt?.outcome==='unknown'
  return <section className="section-block incident-panel" aria-labelledby="create-incident-heading">
    <div className="section-heading"><h2 id="create-incident-heading" ref={heading} tabIndex={-1}>Create incident</h2><button type="button" onClick={props.onClose}>Cancel</button></div>
    <p>Monitoring supplies the technical context. Add the human intent for tracked response.</p>
    {error && <div id="create-incident-error" className="error-banner" role="alert">{error}</div>}
    {frozen && <div className="incident-scope"><strong>Frozen scope: {displayZone(frozen.zone)}</strong><ul>{frozen.accessPoints.map(a=><li key={a.apId}>{a.apId} · {a.expectedCondition}</li>)}</ul></div>}
    {unknown && <div className="incident-notice"><p>Previous create attempt may have completed.</p><p>{attempt.payload.title} · Responder / team: {attempt.payload.responderLabel??'Not set'}</p><button type="button" disabled={busy} onClick={()=>void submit(true)}>Retry same request</button><p>Discarding the local retry record does not undo an incident that may already exist. Review incident discovery before starting another attempt.</p><button type="button" disabled={busy} onClick={()=>discard()}>Discard and review new attempt</button></div>}
    {rejection && <div className="incident-notice"><p>{attempt.problem?.code==='condition_changed'?'The selected technical condition changed. Review current monitoring before a new attempt.':'This request was rejected. Review its intent before starting a new attempt.'}</p>{attempt.problem?.code==='condition_changed'?<button type="button" disabled={busy||!props.canCreate} onClick={()=>discard(true)}>Start new attempt from current condition</button>:<button type="button" disabled={busy} onClick={()=>discard()}>Review and edit new attempt</button>}</div>}
    {(storageIssue || attempt?.outcome==='confirmed') && <div className="incident-notice"><p>Review saved local state before discarding it. Discard does not undo server changes.</p><button type="button" disabled={busy} onClick={()=>discard()}>Discard local retry record</button></div>}
    {draft && <form onSubmit={e=>{e.preventDefault();if(!locked && props.canCreate)void submit()}} aria-describedby={error?'create-incident-error':undefined}>
      <label htmlFor="incident-create-title">Title</label><input id="incident-create-title" required maxLength={200} value={draft.title} disabled={locked} onChange={e=>update({title:e.target.value})}/>
      <label htmlFor="incident-create-responder">Responder / team</label><input id="incident-create-responder" maxLength={100} value={draft.responderLabel} disabled={locked} onChange={e=>update({responderLabel:e.target.value})} aria-describedby="create-responder-help"/>
      <p id="create-responder-help" className="incident-muted">Optional manually entered label; not authenticated assignment.</p>
      {!props.canCreate && !attempt && <p role="status">Current monitoring is unavailable or the selected condition has recovered. Fresh creation is unavailable.</p>}
      <button type="submit" disabled={locked || !props.canCreate || !draft.title.trim() || draft.title.length>200 || draft.responderLabel.length>100}>Create incident</button>
    </form>}
    {busy && <p role="status">Submitting incident request…</p>}
  </section>
}
