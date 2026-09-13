import { useEffect, useRef, useState } from 'react'
import { incidentErrorMessage, incidentStatuses, listIncidents, type IncidentFilters, type IncidentList } from '../api/incidents'
import { displayZone } from '../incidentRequestState'
import { incidentUrl, interceptNavigation } from '../incidentNavigation'

interface Props { filters:IncidentFilters; onFiltersChange:(filters:IncidentFilters)=>void; onOpen:(id:number)=>void }
export function IncidentListPanel(props:Props){return <IncidentListContent key={`${props.filters.status??''}/${props.filters.zone??''}`} {...props}/>}
function IncidentListContent({filters,onFiltersChange,onOpen}:Props){
  const [data,setData]=useState<IncidentList|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true)
  const lifecycle=useRef<{active:boolean;request:AbortController|null;generation:number}>({active:false,request:null,generation:0})
  const dataRef=useRef<IncidentList|null>(null),heading=useRef<HTMLHeadingElement>(null)
  async function load(append=false){
    const owner=lifecycle.current
    if(!owner.active || (append && owner.request))return
    const beforeId=append?dataRef.current?.nextBeforeId:undefined
    if(append && !beforeId)return
    if(!append){owner.generation++;owner.request?.abort()}
    const generation=owner.generation,c=new AbortController();owner.request=c
    const owns=()=>owner.active && lifecycle.current===owner && owner.generation===generation && owner.request===c
    setLoading(true);setError(null)
    try {
      const page=await listIncidents({...filters,beforeId:beforeId??undefined},c.signal)
      if(owns()){
        const rows=append?[...(dataRef.current?.items??[]),...page.items]:page.items
        const next={...page,items:[...new Map(rows.map(row=>[row.id,row])).values()].sort((a,b)=>b.id-a.id)}
        dataRef.current=next;setData(next)
      }
    } catch(e){if(owns())setError(incidentErrorMessage(e))}
    finally{if(owns()){owner.request=null;setLoading(false)}}
  }
  useEffect(()=>{
    const owner={active:true,request:null as AbortController|null,generation:0};lifecycle.current=owner
    heading.current?.focus();void load()
    return ()=>{owner.active=false;owner.request?.abort()}
    // Filter changes remount this content, creating a distinct lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  return <section className="section-block incident-panel" aria-labelledby="incidents-heading">
    <div className="section-heading"><div><p className="section-kicker">Network incident response</p><h2 id="incidents-heading" ref={heading} tabIndex={-1}>Incidents</h2></div><button type="button" onClick={()=>void load()}>Refresh incidents</button></div>
    <div className="incident-filters">
      <label htmlFor="incident-status-filter">Status</label><select id="incident-status-filter" value={filters.status??''} onChange={e=>onFiltersChange({...filters,status:(e.target.value||undefined) as IncidentFilters['status']})}><option value="">All</option>{incidentStatuses.map(s=><option key={s}>{s}</option>)}</select>
      <label htmlFor="incident-zone-filter">Zone</label><select id="incident-zone-filter" value={filters.zone??''} onChange={e=>onFiltersChange({...filters,zone:e.target.value||undefined})}><option value="">All zones</option><option value="zone-a">Zone A</option><option value="zone-b">Zone B</option></select>
    </div>
    <p className="incident-muted">Zone filters use the current fixed simulator inventory.</p>
    {error && <div className="error-banner" role="alert">{error}{data && ' Showing previously loaded incidents for these filters.'}</div>}
    {loading && <p role="status">Loading incidents…</p>}
    {data && !data.items.length && <p>No incidents match these filters.</p>}
    <ul className="incident-list" aria-busy={loading}>{data?.items.map(row=><li className="incident-list-item" key={row.id}>
      <div><a href={incidentUrl({view:'incidents',invalidIncident:false,incidentId:row.id,...filters})} onClick={e=>interceptNavigation(e,()=>onOpen(row.id))}>{row.number} · {row.title}</a><span className="incident-status">{row.status}</span></div>
      <dl><div><dt>Zone</dt><dd>{displayZone(row.zone)}</dd></div><div><dt>Responder / team</dt><dd>{row.responderLabel??'Not set'}</dd></div><div><dt>Affected APs</dt><dd>{row.affectedAccessPointCount}</dd></div><div><dt>Created</dt><dd><time dateTime={row.createdAtUtc}>{new Date(row.createdAtUtc).toLocaleString()}</time></dd></div>{row.resolvedAtUtc && <div><dt>Resolved</dt><dd><time dateTime={row.resolvedAtUtc}>{new Date(row.resolvedAtUtc).toLocaleString()}</time></dd></div>}</dl>
    </li>)}</ul>
    {data?.hasMore && <button type="button" disabled={loading || error!==null} onClick={()=>void load(true)}>Load more</button>}
  </section>
}
