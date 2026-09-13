#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - "$@" <<'PY'
"""Real PostgreSQL creation retry/discovery proof; owns only isolated resources."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--legacy-api-image', required=True)
parser.add_argument('--evidence-dir')
parser.add_argument('--exercise-cleanup-failure', action='store_true')
args = parser.parse_args()
root = Path.cwd().resolve()
evidence = Path(args.evidence_dir or tempfile.mkdtemp(prefix='venue-m6-discovery-evidence-')).resolve()
if evidence == root or root in evidence.parents:
    raise SystemExit('Evidence must be outside the repository.')
evidence.mkdir(parents=True, exist_ok=True)
project = 'venue-network-operations-console'
network = project + '_default'
db_container = project + '-incident-db-1'
api_name = project + '-m6-discovery-api'
migration_name = project + '-m6-discovery-migration'
identifier = 'venueops_m6_discovery_' + secrets.token_hex(6)
assert re.fullmatch(r'venueops_m6_discovery_[0-9a-f]{12}', identifier)
password = secrets.token_hex(32)
temporary = tempfile.TemporaryDirectory(prefix='venue-m6-discovery-credentials-')
env_file = Path(temporary.name) / 'api.env'
owned_api = owned_migration = owned_database = owned_role = mutated = False
base = ''
locker = None
checks = []
incident_id = None


def log(message):
    print(datetime.datetime.now(datetime.timezone.utc).isoformat(), message, flush=True)


def run(*command, input=None, timeout=60, check=True):
    result = subprocess.run(command, input=input, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(f'{command[0]} failed: {(result.stderr or result.stdout).replace(password, "<redacted>")}')
    return result


def sql(statement, database=None):
    return run('docker', 'exec', '-i', db_container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
               '-U', 'venueops', '-d', database or identifier, '-At', input=statement).stdout.strip()


def save(name, value):
    text = json.dumps(value, indent=2, sort_keys=True) + '\n'
    assert password not in text, 'Refusing credential-bearing evidence'
    (evidence / name).write_text(text)


def request(url, method='GET', body=None):
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read().decode()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = raw
        return response.status, value, dict(response.headers), time.monotonic() - started


def expect(url, status=200, method='GET', body=None):
    code, value, headers, elapsed = request(url, method, body)
    assert code == status, (url, status, code, value)
    if status in [409, 503]:
        assert value['status'] == status and 'application/problem+json' in headers.get('Content-Type', '')
    if status == 503:
        assert elapsed < 12, ('unbounded dependency error', elapsed)
    return value


def poll(label, predicate, seconds=65):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                log(label)
                return value
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.25)
    raise AssertionError('Timed out: ' + label)


def reset():
    expect('http://127.0.0.1:8081/simulation/event-day/reset', method='POST')


def healthy():
    value = expect('http://127.0.0.1:8080/api/operations/overview')
    metrics = [(42,.55,.018,.002),(35,.48,.016,.001),(28,.41,.015,.001),(31,.46,.017,.002)]
    return value if all(a['operational'] and not a['degraded'] and a['alertState'] == a['degradationAlertState'] == 'inactive'
        and (a['clients'],a['channelUtilizationRatio'],a['managementLatencySeconds'],a['managementPacketLossRatio']) == m
        for a,m in zip(value['accessPoints'],metrics,strict=True)) and value['probe']['success'] and value['simulatorScrape']['up'] else None


def infrastructure():
    ids = run('docker','ps','-aq','--filter','label=com.docker.compose.project='+project).stdout.split()
    result = {}
    for c in json.loads(run('docker','inspect',*ids).stdout):
        service = c['Config']['Labels']['com.docker.compose.service']
        result[service] = {'id':c['Id'],'image':c['Image'],'bindings':c['HostConfig']['PortBindings'],
                           'mounts':sorted(c['Mounts'],key=lambda m:m['Destination']),'command':c['Config']['Cmd']}
    assert len(result) == 5
    return result


def start_api(image, prometheus='http://prometheus:9090'):
    global owned_api, base
    env_file.write_text(f'Incidents__Host=incident-db\nIncidents__Database={identifier}\nIncidents__Username={identifier}\nIncidents__Password={password}\nPrometheus__BaseUrl={prometheus}\n')
    env_file.chmod(0o600)
    owned_api = True
    run('docker','run','--detach','--pull','never','--name',api_name,'--network',network,
        '--publish','127.0.0.1::8080','--env-file',str(env_file),image)
    refresh_api_address()
    poll('isolated API live',lambda: request(base+'/health/live')[0] == 200)


def refresh_api_address():
    global base
    port = json.loads(run('docker','inspect',api_name).stdout)[0]['NetworkSettings']['Ports']['8080/tcp'][0]
    assert port['HostIp'] == '127.0.0.1'
    base = 'http://127.0.0.1:' + port['HostPort']


def remove_api():
    global owned_api
    if owned_api:
        logs = run('docker','logs',api_name,check=False)
        with (evidence/'api.log').open('a') as file:
            file.write((logs.stdout+logs.stderr).replace(password,'<redacted>'))
        run('docker','rm','--force',api_name)
        owned_api = False


def migrate(image, label):
    global owned_migration
    owned_migration = True
    result = run('docker','run','--rm','--pull','never','--name',migration_name,'--network',network,
                 '--env-file',str(env_file),image,'--migrate-incidents')
    owned_migration = False
    (evidence/(label+'.log')).write_text((result.stdout+result.stderr).replace(password,'<redacted>'))


# A loopback-only test controller can delay/fail a capture independently of the
# direct Prometheus path. It never writes telemetry or adds production endpoints.
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
capture_name = project + '-m6-discovery-capture-api'
owned_capture = False
proxy = None
proxy_thread = None
proxy_release = threading.Event()
proxy_lock = threading.Lock()
proxy_mode = 'forward'
proxy_hits = 0
baseline_queries = {}


def detail(id, cursor=None, address=None):
    suffix = '' if cursor is None else '?beforeEventSequence=' + str(cursor)
    return expect((address or base)+'/api/incidents/'+str(id)+suffix)


def create_body(title, points, responder=None, key=True):
    value = {'title': title, 'accessPoints': [{'apId': ap, 'expectedCondition': condition} for ap,condition in points]}
    if responder is not None: value['responderLabel'] = responder
    if key: value['creationCommandId'] = str(uuid.uuid4())
    return value


def create(body, address=None):
    code,value,headers,_ = request((address or base)+'/api/incidents','POST',body)
    assert code == 201, (code,value)
    assert headers['Location'] == '/api/incidents/'+str(value['id'])
    assert value['number'] == f'INC-{value["id"]:06d}'
    assert value['events'][-1]['sequence'] == value['version']
    return value


def act(id, path, payload):
    state = detail(id)
    body = dict(payload, commandId=str(uuid.uuid4()), expectedVersion=state['version'])
    receipt = expect(base+f'/api/incidents/{id}/'+path,method='PUT' if path=='responder' else 'POST',body=body)
    return body,receipt


def counts():
    return sql('SELECT (SELECT count(*) FROM "Incidents"),(SELECT count(*) FROM "IncidentAccessPoints"),(SELECT count(*) FROM "IncidentEvents"),(SELECT count("CreationCommandId") FROM "Incidents");')


def graph_counts(key):
    # Keys passed here are generated/validated UUIDs, never operator SQL text.
    key = str(uuid.UUID(key))
    return sql(f'''SELECT count(*), (SELECT count(*) FROM "IncidentAccessPoints" a JOIN "Incidents" i ON a."IncidentId"=i."Id" WHERE i."CreationCommandId"='{key}'),
(SELECT count(*) FROM "IncidentEvents" e JOIN "Incidents" i ON e."IncidentId"=i."Id" WHERE i."CreationCommandId"='{key}') FROM "Incidents" WHERE "CreationCommandId"='{key}';''')


def collected_peak():
    value=expect('http://127.0.0.1:8080/api/operations/overview')
    return value if all(a['operational'] and a['degraded'] and a['degradationAlertState']=='firing' for a in value['accessPoints'][:2]) else None


def release_lock():
    global locker
    if locker:
        try: locker.stdin.write('COMMIT;\n\\q\n'); locker.stdin.flush()
        except BrokenPipeError: pass
        try: locker.communicate(timeout=4)
        except subprocess.TimeoutExpired: locker.kill(); locker.communicate(timeout=2)
        locker=None


def race_creates(bodies):
    global locker
    # SHARE permits the preflight reads but holds both INSERTs. This establishes
    # actual overlapping database writes, rather than merely two fast HTTP calls.
    locker=subprocess.Popen(['docker','exec','-i',db_container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
        '-U','venueops','-d',identifier],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    locker.stdin.write('BEGIN; SET LOCAL idle_in_transaction_session_timeout=\'2500ms\';\n'
        'LOCK TABLE "Incidents" IN SHARE MODE; SELECT \'LOCKED\';\n'); locker.stdin.flush()
    assert select.select([locker.stdout],[],[],2)[0] and locker.stdout.readline().strip()=='LOCKED'
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(request,base+'/api/incidents','POST',body) for body in bodies]
        try:
            deadline=time.monotonic()+1.5; waiting=0
            while time.monotonic()<deadline:
                waiting=int(sql(f"SELECT count(*) FROM pg_stat_activity WHERE datname='{identifier}' AND wait_event_type='Lock';"))
                if waiting>=2:break
                time.sleep(.02)
            assert waiting>=2, 'Could not establish two overlapping creation writes'
        finally: release_lock()
        results=[f.result(timeout=15) for f in futures]
    return {'postgresWaiters':waiting,'responses':results}


def proxy_configure(mode, hold):
    global proxy_mode, proxy_hits
    with proxy_lock:
        proxy_mode=mode; proxy_hits=0
        if hold:proxy_release.clear()
        else:proxy_release.set()


class CaptureProxy(BaseHTTPRequestHandler):
    def do_GET(self):
        global proxy_hits
        expression=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('query',[''])[0]
        if expression not in baseline_queries:
            self.send_response(404);self.end_headers();return
        with proxy_lock:
            mode=proxy_mode
            if expression=='venue_ap_operational':proxy_hits+=1
        if expression=='venue_ap_operational' and not proxy_release.wait(2.5):
            self.send_response(504);self.end_headers();return
        if mode=='error' and expression=='venue_ap_operational':
            code=503;data=b'{"status":"error","error":"controlled capture failure"}'
        elif mode=='baseline':
            code=200;data=json.dumps(baseline_queries[expression]).encode()
        else:
            code,value,_,_=request('http://127.0.0.1:9090'+self.path)
            data=json.dumps(value).encode()
        try:
            self.send_response(code);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*args):pass


class CaptureServer(ThreadingHTTPServer):
    request_queue_size=64
    daemon_threads=True


def start_capture_api(image):
    global owned_capture, proxy, proxy_thread
    proxy=CaptureServer(('127.0.0.1',0),CaptureProxy)
    proxy_thread=threading.Thread(target=proxy.serve_forever,daemon=True);proxy_thread.start()
    owned_capture=True
    run('docker','run','--detach','--pull','never','--name',capture_name,'--network',network,
        '--publish','127.0.0.1::8080','--env-file',str(env_file),
        '--env',f'Prometheus__BaseUrl=http://host.docker.internal:{proxy.server_port}',image)
    port=json.loads(run('docker','inspect',capture_name).stdout)[0]['NetworkSettings']['Ports']['8080/tcp'][0]
    assert port['HostIp']=='127.0.0.1'
    address='http://127.0.0.1:'+port['HostPort']
    poll('capture-test API live',lambda: request(address+'/health/live')[0]==200)
    proxy_configure('forward',False)
    assert expect(address+'/api/operations/overview')['simulatorScrape']['up']
    return address


def list_page(**parameters):
    suffix='?'+urllib.parse.urlencode(parameters) if parameters else ''
    value=expect(base+'/api/incidents'+suffix)
    assert set(value)=={'items','hasMore','nextBeforeId'} and len(value['items'])<=50
    fields={'id','number','title','status','zone','responderLabel','createdAtUtc','resolvedAtUtc','version','affectedAccessPointCount'}
    assert all(set(row)==fields for row in value['items'])
    ids=[row['id'] for row in value['items']];assert ids==sorted(ids,reverse=True)
    assert value['nextBeforeId']==(min(ids) if value['hasMore'] else None)
    return value


def malformed_zone_filters(label):
    before = run('docker', 'logs', api_name)
    results = {}
    for query in ['zone=%00', 'zone=zone-a%00', 'zone=zone%00-a']:
        code, value, headers, _ = request(base + '/api/incidents?' + query)
        assert code == 400 and value['status'] == 400, (query, code, value)
        assert value['title'] == 'Invalid incident request'
        assert 'application/problem+json' in headers.get('Content-Type', '')
        results[query] = {'status': code, 'title': value['title']}
    after = run('docker', 'logs', api_name)
    assert after.stdout.startswith(before.stdout) and after.stderr.startswith(before.stderr)
    added_logs = after.stdout[len(before.stdout):] + after.stderr[len(before.stderr):]
    assert 'Microsoft.EntityFrameworkCore.Database.' not in added_logs, 'Malformed zones reached EF database execution'
    assert '22021' not in added_logs, 'Malformed zones reached PostgreSQL text validation'
    save('malformed-zones-' + label + '.json', {'responses': results, 'noDatabaseExecutionLogged': True})


def interrupted(signum,frame):raise KeyboardInterrupt('Discovery verification interrupted')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
try:
    for name in [api_name,migration_name,capture_name]:
        assert run('docker','container','inspect',name,check=False).returncode!=0,'Refusing existing resource: '+name
    legacy=run('docker','image','inspect',args.legacy_api_image,check=False)
    assert legacy.returncode==0,'Required Task 2 image is unavailable; cannot skip legacy proof'
    legacy_image=json.loads(legacy.stdout)[0]['Id']
    current_image=json.loads(run('docker','image','inspect',project+'-venue-api').stdout)[0]['Id']
    assert legacy_image!=current_image,'Build the Task 3A API first'
    before_infrastructure=infrastructure();save('infrastructure-before.json',before_infrastructure)
    volume_before=json.loads(run('docker','volume','inspect',project+'_prometheus-data',project+'_incident-data').stdout)
    normal_counts=sql('SELECT (SELECT count(*) FROM "Incidents"),(SELECT count(*) FROM "IncidentAccessPoints"),(SELECT count(*) FROM "IncidentEvents");','venueops_incidents')
    assert normal_counts=='0|0|0'
    end=int(time.time())-60
    history_url='http://127.0.0.1:9090/api/v1/query_range?'+urllib.parse.urlencode({'query':'venue_ap_operational{ap_id="ap-001"}','start':end-120,'end':end,'step':5})
    history=expect(history_url);assert history['data']['result'][0]['values'];save('history-before.json',history)
    (evidence/'history-url.txt').write_text(history_url)
    assert not sql(f"SELECT 1 FROM pg_database WHERE datname='{identifier}';",'postgres')
    assert not sql(f"SELECT 1 FROM pg_roles WHERE rolname='{identifier}';",'postgres')
    owned_role=True;sql(f"CREATE ROLE {identifier} LOGIN PASSWORD '{password}';",'postgres')
    owned_database=True;sql(f'CREATE DATABASE {identifier} OWNER {identifier};','postgres')
    start_api(legacy_image);migrate(legacy_image,'legacy-migration')
    assert len(sql('SELECT "MigrationId" FROM "__EFMigrationsHistory";').splitlines())==2
    assert sql("SELECT count(*) FROM information_schema.columns WHERE table_name='Incidents' AND column_name='CreationCommandId';")=='0'
    mutated=True;reset();poll('collected exact baseline',healthy)
    expressions=['venue_ap_operational','venue_ap_clients','venue_ap_channel_utilization_ratio',
        'venue_ap_management_latency_seconds','venue_ap_management_packet_loss_ratio','zone:venue_ap_operational:avg',
        'zone:venue_ap_clients:sum','up{job="venue-ap-simulator"}',
        *[metric+'{job="blackbox-http",instance="http://venue-api:8080/health/live"}' for metric in ['probe_success','probe_duration_seconds','probe_http_status_code']],
        'ALERTS{alertname="VenueApDown"}','ALERTS{alertname="VenueApDegraded"}']
    baseline_queries={q:expect('http://127.0.0.1:9090/api/v1/query?'+urllib.parse.urlencode({'query':q})) for q in expressions}
    expect('http://127.0.0.1:8081/simulation/event-day/position',method='PUT',body={'elapsedMinutes':360})
    poll('collected peak and firing warnings',collected_peak)
    legacy_rows=[]
    for n in range(2):
        row=create(create_body('Legacy response '+str(n),[('ap-001','degraded'),('ap-002','degraded')],'Initial team',False))
        act(row['id'],'responder',{'responderLabel':'Current team'})
        act(row['id'],'transitions',{'status':'Investigating'})
        act(row['id'],'notes',{'text':'Legacy investigation evidence'})
        if n:act(row['id'],'transitions',{'status':'Resolved','note':'Legacy resolution'})
        legacy_rows.append(detail(row['id']))
    save('legacy-incidents.json',legacy_rows)
    if args.exercise_cleanup_failure:raise AssertionError('Intentional verifier failure after legacy creation and simulator mutation')
    remove_api();start_api(current_image)
    assert request(base+'/health/ready/incidents')[0]==503
    migrate(current_image,'discovery-migration')
    assert request(base+'/health/ready/incidents')[0]==200
    assert sql('SELECT count(*) FROM "Incidents" WHERE "CreationCommandId" IS NOT NULL;')=='0'
    assert [detail(row['id']) for row in legacy_rows]==legacy_rows
    migration_rows=sql('SELECT * FROM "__EFMigrationsHistory" ORDER BY "MigrationId";')
    assert len(migration_rows.splitlines())==3
    migrate(current_image,'discovery-repeat')
    assert migration_rows==sql('SELECT * FROM "__EFMigrationsHistory" ORDER BY "MigrationId";')
    assert [detail(row['id']) for row in legacy_rows]==legacy_rows
    model=run('dotnet','ef','migrations','has-pending-model-changes','--project','src/VenueOps.Api','--no-build')
    (evidence/'model-consistency.log').write_text(model.stdout+model.stderr)
    checks.append('nonempty Task 2 migration preserves complete legacy state/history; null keys; repeat no-op; no pending model changes');log(checks[-1])

    # JSON binding, domain validation, and unchanged legacy compatibility.
    valid=create_body('Validation',[('ap-001','degraded')])
    for bad in [dict(valid,creationCommandId='bad'),dict(valid,creationCommandId=str(uuid.UUID(int=0))),
                dict(valid,title=''),dict(valid,clients=1),dict(valid,accessPoints=valid['accessPoints']*2)]:
        expect(base+'/api/incidents',400,'POST',bad)
    for query in ['status=Unknown','status=open','status=','zone=','zone=%20','zone='+'x'*65,
                  'beforeId=0','beforeId=-1','beforeId=bad','beforeId=9223372036854775808']:
        expect(base+'/api/incidents?'+query,400)
    malformed_zone_filters('healthy-database')
    assert list_page(zone='unknown-zone')=={'items':[],'hasMore':False,'nextBeforeId':None}
    assert list_page(beforeId=1)['items']==[]

    reset();poll('baseline before single-AP capture',healthy)
    outage_body=create_body('AP outage',[('ap-001','offline')])
    failure=expect(base+'/api/incidents',409,'POST',outage_body);assert failure['code']=='condition_changed'
    expect('http://127.0.0.1:8081/simulation/access-points/ap-001',method='PUT',body={'scenario':'offline'})
    poll('collected single-AP outage',lambda:not expect(base+'/api/operations/overview')['accessPoints'][0]['operational'])
    outage=create(outage_body);ap=outage['monitoringEvidence']['accessPoints'][0]
    assert not ap['operational'] and not ap['degraded'] and ap['clients']==0
    assert all(ap[k] is None for k in ['channelUtilizationRatio','managementLatencySeconds','managementPacketLossRatio'])
    assert create(outage_body)==outage and graph_counts(outage_body['creationCommandId'])=='1|1|1'
    reset();poll('outage recovered; stored replay still succeeds',healthy)
    assert create(outage_body)==outage
    save('outage-request.json',outage_body);save('outage-response.json',outage)
    expect('http://127.0.0.1:8081/simulation/event-day/position',method='PUT',body={'elapsedMinutes':360})
    observed=poll('collected multi-AP degradation',collected_peak)
    body=create_body('Zone A degradation',[('ap-001','degraded'),('ap-002','degraded')],'Initial team')
    original=create(body);id=original['id']
    for ap in original['monitoringEvidence']['accessPoints']:
        source=next(a for a in observed['accessPoints'] if a['apId']==ap['apId'])
        for field in ['operational','degraded','clients','channelUtilizationRatio','managementLatencySeconds','managementPacketLossRatio','alertState','degradationAlertState']:
            assert ap[field]==source[field],(field,ap,source)
        assert ap['degradationAlert']['state']=='firing'
    equivalent=dict(body,title='  '+body['title']+'  ',responderLabel=' Initial team ',accessPoints=list(reversed(body['accessPoints'])))
    assert create(equivalent)==original and graph_counts(body['creationCommandId'])=='1|2|1'
    assert expect(base+'/api/incidents',409,'POST',dict(body,title='Different intent'))['code']=='creation_command_conflict'
    save('create-request.json',body);save('create-response.json',original)
    act(id,'responder',{'responderLabel':'Changed current team'})
    act(id,'transitions',{'status':'Investigating'})
    for n in range(105):
        act(id,'notes',{'text':f'Chronology beyond creation page {n}'})
        if n%25==0:log('appended chronology '+str(n))
    act(id,'transitions',{'status':'Resolved','note':'Human response complete'})
    current=detail(id);assert current['version']>100 and current['hasEarlierEvents'] and len(current['events'])==100
    assert all(e['kind']!='Created' for e in current['events'])
    assert current['monitoringEvidence']==original['monitoringEvidence']
    before_counts=counts();assert create(equivalent)==current and counts()==before_counts
    assert expect(base+'/api/incidents',409,'POST',dict(body,responderLabel='Changed current team'))['code']=='creation_command_conflict'
    run('docker','restart',api_name);refresh_api_address();poll('isolated API restart ready',lambda:request(base+'/health/ready/incidents')[0]==200)
    assert create(body)==current and counts()==before_counts
    save('replay-current.json',current)
    checks.append('outage and multi-AP capture; normalized replay; original responder beyond 100 events; current coherent replay; API restart');log(checks[-1])

    same=create_body('Concurrent identical',[('ap-001','degraded')])
    same_race=race_creates([same,same]);responses=same_race['responses']
    assert [r[0] for r in responses]==[201,201] and responses[0][1]==responses[1][1],same_race
    assert graph_counts(same['creationCommandId'])=='1|1|1'
    different=create_body('Concurrent intent A',[('ap-001','degraded')])
    different_race=race_creates([different,dict(different,title='Concurrent intent B')]);responses=different_race['responses']
    assert sorted(r[0] for r in responses)==[201,409],different_race
    assert next(r[1] for r in responses if r[0]==409)['code']=='creation_command_conflict'
    assert graph_counts(different['creationCommandId'])=='1|1|1'
    save('concurrent-creates.json',{'identical':same_race,'different':different_race})
    checks.append('real overlapping PostgreSQL creation writes: identical 201/201, conflicting intent 201/409, one graph per key');log(checks[-1])

    capture_base=start_capture_api(current_image)
    capture_results=[]
    for mode,expected_failure in [('error',503),('baseline',409)]:
        racing=create_body('Capture recheck '+mode,[('ap-001','degraded')])
        proxy_configure(mode,True)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending=pool.submit(request,capture_base+'/api/incidents','POST',racing)
            try:
                poll('competing capture entered '+mode,lambda:proxy_hits>=1,seconds=1.5)
                winner=create(racing)
            finally:proxy_release.set()
            code,recovered,headers,_=pending.result(timeout=15)
        assert code==201 and recovered==winner and headers['Location']=='/api/incidents/'+str(winner['id'])
        assert graph_counts(racing['creationCommandId'])=='1|1|1'
        proxy_configure(mode,False)
        unused=create_body('No committed winner '+mode,[('ap-001','degraded')])
        failed=expect(capture_base+'/api/incidents',expected_failure,'POST',unused)
        if expected_failure==409:assert failed['code']=='condition_changed'
        assert graph_counts(unused['creationCommandId'])=='0|0|0'
        capture_results.append({'mode':mode,'recoveredStatus':code,'incidentId':winner['id'],'noWinnerStatus':expected_failure})
    proxy_configure('forward',False)
    save('capture-rechecks.json',capture_results)
    checks.append('committed winner recovered after controlled capture failure AND changed condition; no-winner failures stay bounded');log(checks[-1])

    failed_body=create_body('Atomic creation rollback',[('ap-001','degraded')])
    before=counts()
    sql('''CREATE FUNCTION fail_created() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional Created rollback'; END $$;
CREATE TRIGGER fail_created BEFORE INSERT ON "IncidentEvents" FOR EACH ROW EXECUTE FUNCTION fail_created();''')
    expect(base+'/api/incidents',503,'POST',failed_body)
    assert counts()==before and graph_counts(failed_body['creationCommandId'])=='0|0|0'
    sql('DROP TRIGGER fail_created ON "IncidentEvents"; DROP FUNCTION fail_created();')
    create(failed_body);assert graph_counts(failed_body['creationCommandId'])=='1|1|1'
    keyless=create_body('Legacy caller',[('ap-001','degraded')],key=False)
    legacy_created=[create(keyless),create(keyless),create(dict(keyless,creationCommandId=None)),create(dict(keyless,creationCommandId=None))]
    assert len({row['id'] for row in legacy_created})==4
    for row in legacy_created:assert sql(f'SELECT "CreationCommandId" IS NULL FROM "Incidents" WHERE "Id"={row["id"]};')=='t'
    independent=create(dict(body,creationCommandId=str(uuid.uuid4())));assert independent['id']!=id
    checks.append('atomic graph/key rollback and same-key recovery; omitted/null keys independently create; different keys do not correlate intent');log(checks[-1])

    assert list_page(zone='zone-b')['items']==[]
    expect('http://127.0.0.1:8081/simulation/access-points/ap-003',method='PUT',body={'scenario':'offline'})
    poll('Zone B outage for isolated discovery dataset',lambda:not expect(base+'/api/operations/overview')['accessPoints'][2]['operational'])
    zone_b=[]
    for n in range(51):
        zone_b.append(create(create_body('Discovery row '+str(n),[('ap-003','offline')])))
        if n==0:
            page=list_page(zone='zone-b');assert len(page['items'])==1 and not page['hasMore']
        if n==49:
            page=list_page(zone='zone-b');assert len(page['items'])==50 and not page['hasMore']
        if n%10==0:log('HTTP-created discovery rows '+str(n+1))
    page=list_page(zone='zone-b');assert len(page['items'])==50 and page['hasMore']
    tail=list_page(zone='zone-b',beforeId=page['nextBeforeId']);assert len(tail['items'])==1 and not tail['hasMore']
    first=list_page();ids=[r['id'] for r in first['items']];cursor=first['nextBeforeId']
    while cursor is not None:
        page=list_page(beforeId=cursor);ids.extend(r['id'] for r in page['items']);cursor=page['nextBeforeId']
    stored=[int(i) for i in sql('SELECT "Id" FROM "Incidents" ORDER BY "Id" DESC;').splitlines()]
    assert ids==stored and len(ids)==len(set(ids)) and len(ids)>50
    newer=create(create_body('New between pages',[('ap-003','offline')]))
    second=list_page(beforeId=first['nextBeforeId'])
    assert newer['id'] not in [r['id'] for r in second['items']]
    assert all(r['id']<first['nextBeforeId'] for r in second['items'])
    assert list_page()['items'][0]['id']==newer['id']
    changed=zone_b[-1]['id'];act(changed,'responder',{'responderLabel':'Discovery team'})
    act(changed,'transitions',{'status':'Monitoring'})
    monitoring=list_page(status='Monitoring',zone='zone-b')
    assert [r['id'] for r in monitoring['items']]==[changed]
    assert monitoring['items'][0]['responderLabel']=='Discovery team' and monitoring['items'][0]['version']==3
    act(changed,'transitions',{'status':'Resolved','note':'Discovery verification complete'})
    assert list_page(status='Monitoring',zone='zone-b')['items']==[]
    resolved=list_page(status='Resolved',zone='zone-b')['items'];assert len(resolved)==1 and resolved[0]['resolvedAtUtc']==detail(changed)['resolvedAtUtc']
    assert all(r['status']=='Open' for r in list_page(status='Open')['items'])
    assert all(r['zone']=='zone-a' for r in list_page(zone='zone-a')['items'])
    save('list-response.json',list_page());save('discovery-traversal.json',{'idsBeforeInsert':ids,'newId':newer['id'],'zoneBResolved':resolved})
    checks.append('HTTP-created >50 incidents; empty/1/50/51 pages; complete traversal; exclusive cursor/new insert; status/zone/AND filters; fresh workflow summaries only');log(checks[-1])

    reset();poll('recovered monitoring before dependency proofs',healthy)
    assert create(body)==current
    remove_api();start_api(current_image,'http://127.0.0.1:1')
    assert detail(id)==current and create(body)==current and list_page()['items']
    expect(base+'/api/incidents',503,'POST',create_body('Fresh capture unavailable',[('ap-001','degraded')]))
    remove_api();start_api(current_image)
    before=detail(id);started=json.loads(run('docker','inspect',api_name).stdout)[0]['State']['StartedAt']
    sql(f'ALTER ROLE {identifier} NOLOGIN;','postgres')
    sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{identifier}' AND pid<>pg_backend_pid();",'postgres')
    assert request(base+'/health/live')[0]==200
    expect(base+'/api/operations/overview')
    assert request(base+'/health/ready/incidents')[0]==503
    expect(base+'/api/incidents',503);expect(base+'/api/incidents/'+str(id),503)
    expect(base+'/api/incidents',503,'POST',body)
    expect(base+'/api/incidents',503,'POST',create_body('Fresh DB unavailable',[('ap-001','degraded')]))
    malformed_zone_filters('unavailable-database')
    assert json.loads(run('docker','inspect',api_name).stdout)[0]['State']['StartedAt']==started
    sql(f'ALTER ROLE {identifier} LOGIN;','postgres')
    poll('database access recovered',lambda:request(base+'/health/ready/incidents')[0]==200)
    assert detail(id)==before and create(body)==before and list_page()['items']
    checks.append('list/detail/replay independent of Prometheus; fresh capture 503; database outage isolated from liveness/monitoring; durable recovery');log(checks[-1])
    save('results.json',{'checks':checks,'legacyImage':legacy_image,'currentImage':current_image,'counts':counts(),'migrationRows':migration_rows})
finally:
    errors=[];proxy_release.set();release_lock()
    if mutated:
        try:reset();poll('cleanup: exact baseline and inactive alerts',healthy)
        except Exception as error:errors.append(str(error))
    try:
        if owned_capture:run('docker','rm','--force',capture_name)
        if proxy:proxy.shutdown();proxy.server_close();proxy_thread.join(timeout=2)
        remove_api()
        if owned_migration:run('docker','rm','--force',migration_name,check=False)
        if owned_database:
            sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{identifier}' AND pid<>pg_backend_pid();",'postgres')
            sql(f'DROP DATABASE {identifier};','postgres')
        if owned_role:sql(f'DROP ROLE {identifier};','postgres')
    except Exception as error:errors.append(str(error))
    temporary.cleanup()
    try:
        if 'before_infrastructure' in globals():
            assert infrastructure()==before_infrastructure
            assert json.loads(run('docker','volume','inspect',project+'_prometheus-data',project+'_incident-data').stdout)==volume_before
            after_history=expect(history_url);assert after_history==history;save('history-after.json',after_history)
            assert sql('SELECT (SELECT count(*) FROM "Incidents"),(SELECT count(*) FROM "IncidentAccessPoints"),(SELECT count(*) FROM "IncidentEvents");','venueops_incidents')==normal_counts
        if owned_database:assert not sql(f"SELECT 1 FROM pg_database WHERE datname='{identifier}';",'postgres')
        if owned_role:assert not sql(f"SELECT 1 FROM pg_roles WHERE rolname='{identifier}';",'postgres')
        for name in [api_name,migration_name,capture_name]:assert run('docker','container','inspect',name,check=False).returncode!=0
    except Exception as error:errors.append('preservation: '+str(error))
    save('cleanup.json',{'errors':errors,'isolatedResourcesRemoved':not errors,'temporaryCredentialsRemoved':not env_file.exists()})
    if errors:raise AssertionError('Cleanup/preservation failed: '+repr(errors))
log('PASS: Task 3A real PostgreSQL retry-safe creation and bounded discovery')
print('Evidence: '+str(evidence),flush=True)
PY
