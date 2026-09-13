import { isIncidentStatus, positiveInteger, type IncidentFilters } from './api/incidents'
export interface IncidentLocation extends IncidentFilters { view:'monitoring'|'incidents'; incidentId?:number; invalidIncident:boolean }
export function parseIncidentLocation(url=window.location.href):IncidentLocation {
  const q=new URL(url,window.location.origin).searchParams
  if(q.get('view')!=='incidents')return {view:'monitoring',invalidIncident:false}
  const raw=q.get('incident'),id=raw!==null && /^\d+$/.test(raw)?Number(raw):NaN
  return {view:'incidents',incidentId:positiveInteger(id)?id:undefined,invalidIncident:raw!==null && !positiveInteger(id),
    status:isIncidentStatus(q.get('status'))?q.get('status') as IncidentLocation['status']:undefined,
    zone:['zone-a','zone-b'].includes(q.get('zone')??'')?q.get('zone')!:undefined}
}
export function incidentUrl(route:IncidentLocation):string {
  if(route.view==='monitoring')return '/'
  const q=new URLSearchParams({view:'incidents'})
  if(route.incidentId!==undefined && positiveInteger(route.incidentId))q.set('incident',String(route.incidentId))
  if(route.status)q.set('status',route.status)
  if(route.zone)q.set('zone',route.zone)
  return '?'+q
}
const navigationEvent='venueops:navigation'
export function navigateIncident(route:IncidentLocation,replace=false){
  window.history[replace?'replaceState':'pushState'](null,'',incidentUrl(route))
  window.dispatchEvent(new Event(navigationEvent))
}
export function listenIncidentNavigation(listener:()=>void){
  window.addEventListener('popstate',listener);window.addEventListener(navigationEvent,listener)
  return ()=>{window.removeEventListener('popstate',listener);window.removeEventListener(navigationEvent,listener)}
}
export function interceptNavigation(event: {button:number;metaKey:boolean;ctrlKey:boolean;shiftKey:boolean;altKey:boolean;preventDefault:()=>void},action:()=>void){
  if(event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return
  event.preventDefault();action()
}
