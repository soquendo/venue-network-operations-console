#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - "$@" <<'PY'
"""Real PostgreSQL workflow proof; owns only isolated databases/roles/API containers."""
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
evidence = Path(args.evidence_dir or tempfile.mkdtemp(prefix='venue-m6-workflow-evidence-')).resolve()
if evidence == root or root in evidence.parents:
    raise SystemExit('Evidence must be outside the repository.')
evidence.mkdir(parents=True, exist_ok=True)
project = 'venue-network-operations-console'
network = project + '_default'
db_container = project + '-incident-db-1'
api_name = project + '-m6-workflow-api'
migration_name = project + '-m6-workflow-migration'
identifier = 'venueops_m6_workflow_' + secrets.token_hex(6)
assert re.fullmatch(r'venueops_m6_workflow_[0-9a-f]{12}', identifier)
password = secrets.token_hex(32)
temporary = tempfile.TemporaryDirectory(prefix='venue-m6-workflow-credentials-')
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


def detail(cursor=None):
    suffix = '' if cursor is None else '?beforeEventSequence='+str(cursor)
    return expect(base+'/api/incidents/'+str(incident_id)+suffix)


def command(path, payload, version=None, command_id=None):
    value = {'commandId':command_id or str(uuid.uuid4()), 'expectedVersion':detail()['version'] if version is None else version, **payload}
    return path, ('PUT' if path == 'responder' else 'POST'), value


def submit(cmd, status=200):
    path,method,body = cmd
    return expect(base+'/api/incidents/'+str(incident_id)+'/'+path,status,method,body)


def act(path, payload):
    cmd = command(path,payload)
    receipt = submit(cmd)
    assert receipt['incidentId'] == incident_id and receipt['commandId'] == cmd[2]['commandId']
    assert receipt['version'] == cmd[2]['expectedVersion']+1 == receipt['event']['sequence']
    assert detail()['version'] == receipt['version']
    return cmd,receipt


def timeline():
    entries=[];cursor=None
    while True:
        page=detail(cursor)
        sequences=[e['sequence'] for e in page['events']]
        assert len(sequences)<=100 and sequences==sorted(sequences)
        assert all(s<=page['version'] for s in sequences)
        if cursor is not None:assert all(s<cursor for s in sequences)
        entries.extend(page['events'])
        if not page['hasEarlierEvents']:
            assert page['nextBeforeEventSequence'] is None
            break
        assert page['nextBeforeEventSequence']==min(sequences)
        cursor=page['nextBeforeEventSequence']
    entries.sort(key=lambda e:e['sequence'])
    assert [e['sequence'] for e in entries]==list(range(1,detail()['version']+1))
    return entries


def release_lock():
    global locker
    if locker is not None:
        try:
            locker.communicate('COMMIT;\n',timeout=3)
        except Exception:
            locker.kill();locker.communicate(timeout=3)
        locker=None


def race(commands):
    global locker
    # Own an isolated row lock long enough to establish actual overlapping writes.
    locker=subprocess.Popen(['docker','exec','-i',db_container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
                             '-U','venueops','-d',identifier],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    locker.stdin.write('BEGIN; SET LOCAL idle_in_transaction_session_timeout=\'2500ms\';\n'
                       f'SELECT \'LOCKED\' FROM "Incidents" WHERE "Id"={incident_id} FOR UPDATE;\n')
    locker.stdin.flush()
    assert select.select([locker.stdout],[],[],2)[0], 'Lock setup timed out'
    assert locker.stdout.readline().strip()=='LOCKED'
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending=[pool.submit(request,base+'/api/incidents/'+str(incident_id)+'/'+c[0],c[1],c[2]) for c in commands]
        try:
            deadline=time.monotonic()+1.5;waiting=0
            while time.monotonic()<deadline:
                waiting=int(sql(f"SELECT count(*) FROM pg_stat_activity WHERE datname='{identifier}' AND wait_event_type='Lock';"))
                if waiting>=2:break
                time.sleep(.02)
            assert waiting>=2, 'Could not establish two overlapping PostgreSQL writes'
        finally:
            release_lock()
        results=[f.result(timeout=15) for f in pending]
    return results


def interrupted(signum,frame):
    raise KeyboardInterrupt('Workflow verification interrupted')


signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
try:
    for name in [api_name,migration_name]:
        assert run('docker','container','inspect',name,check=False).returncode!=0,'Refusing existing resource: '+name
    legacy=run('docker','image','inspect',args.legacy_api_image,check=False)
    assert legacy.returncode==0,'Required legacy API image unavailable; migration proof cannot be skipped'
    legacy_image=json.loads(legacy.stdout)[0]['Id']
    current_image=json.loads(run('docker','image','inspect',project+'-venue-api').stdout)[0]['Id']
    assert current_image!=legacy_image,'Build the Task 2 API before verification'
    before_infrastructure=infrastructure();save('infrastructure-before.json',before_infrastructure)
    volume_before=json.loads(run('docker','volume','inspect',project+'_prometheus-data',project+'_incident-data').stdout)
    normal_counts=sql('SELECT (SELECT count(*) FROM "Incidents"),(SELECT count(*) FROM "IncidentAccessPoints"),(SELECT count(*) FROM "IncidentEvents");','venueops_incidents')
    assert normal_counts=='0|0|0'
    end=int(time.time())-60
    history_url='http://127.0.0.1:9090/api/v1/query_range?'+urllib.parse.urlencode({'query':'venue_ap_operational{ap_id="ap-001"}','start':end-300,'end':end,'step':5})
    history=expect(history_url);assert history['data']['result'][0]['values'];save('history-before.json',history)
    (evidence/'history-url.txt').write_text(history_url)
    assert not sql(f"SELECT 1 FROM pg_database WHERE datname='{identifier}';",'postgres')
    assert not sql(f"SELECT 1 FROM pg_roles WHERE rolname='{identifier}';",'postgres')
    owned_role=True;sql(f"CREATE ROLE {identifier} LOGIN PASSWORD '{password}';",'postgres')
    owned_database=True;sql(f'CREATE DATABASE {identifier} OWNER {identifier};','postgres')
    start_api(legacy_image);migrate(legacy_image,'legacy-migration')
    assert sql('SELECT "MigrationId" FROM "__EFMigrationsHistory";')=='20260913011623_InitialIncidents'
    assert sql("SELECT count(*) FROM information_schema.columns WHERE table_name='Incidents' AND column_name='Version';")=='0'
    mutated=True
    reset();poll('collected baseline',healthy)
    expect('http://127.0.0.1:8081/simulation/event-day/position',method='PUT',body={'elapsedMinutes':360})
    def peak():
        overview=expect(base+'/api/operations/overview')
        return overview if all(a['operational'] and a['degraded'] and a['degradationAlertState']=='firing' for a in overview['accessPoints'][:2]) else None
    poll('current Zone A degradation observed',peak)
    create_body={'title':'Zone A workflow verification','responderLabel':'Initial response team','accessPoints':[{'apId':a,'expectedCondition':'degraded'} for a in ['ap-001','ap-002']]}
    code,original,headers,_=request(base+'/api/incidents','POST',create_body)
    assert code==201 and headers['Location']=='/api/incidents/'+str(original['id'])
    incident_id=original['id'];assert detail()==original;save('legacy-incident.json',original)
    if args.exercise_cleanup_failure:
        raise AssertionError('Intentional verifier failure after incident creation and simulator mutation')
    remove_api();start_api(current_image)
    assert request(base+'/health/ready/incidents')[0]==503
    expect(base+'/api/operations/overview')
    migrate(current_image,'workflow-migration')
    assert request(base+'/health/ready/incidents')[0]==200
    upgraded=detail()
    for field,value in original.items():
        if field!='events':assert upgraded[field]==value,(field,'legacy field changed')
    for field,value in original['events'][0].items():assert upgraded['events'][0][field]==value
    assert upgraded['version']==1 and upgraded['resolvedAtUtc'] is None
    created_event=upgraded['events'][0]
    assert created_event['sequence']==1 and created_event['commandId'] is None
    assert created_event['toStatus']=='Open' and created_event['responderLabel']==original['responderLabel']
    migrations=sql('SELECT * FROM "__EFMigrationsHistory" ORDER BY "MigrationId";')
    migrate(current_image,'workflow-repeat')
    assert migrations==sql('SELECT * FROM "__EFMigrationsHistory" ORDER BY "MigrationId";') and detail()==upgraded
    save('upgraded-incident.json',upgraded);checks.append('nonempty Task 1 migration; immutable evidence; initial chronology backfill; repeat no-op');log(checks[-1])

    for suffix in ['?beforeEventSequence=0','?beforeEventSequence=-1','?beforeEventSequence=bad']:
        expect(base+'/api/incidents/'+str(incident_id)+suffix,400)
    assert detail(99999)==detail()
    for path,payload in [('notes',{'text':'Valid note'}),('transitions',{'status':'Monitoring'}),('responder',{'responderLabel':None})]:
        cmd=command(path,payload)
        expect(base+'/api/incidents/999999/'+path,404,cmd[1],cmd[2])
    for path,payload in [('notes',{'text':'  '}),('notes',{'text':'x'*2001}),
                         ('transitions',{'status':'resolved'}),('transitions',{'status':'Resolved','note':' '}),
                         ('responder',{'responderLabel':'x'*101})]:
        submit(command(path,payload),400)
    assert detail()==upgraded
    bad=command('responder',{})
    submit(bad,400)
    clear_cmd,clear_receipt=act('responder',{'responderLabel':None})
    assert detail()['responderLabel'] is None
    submit(command('responder',{'responderLabel':'  '}),409)
    act('responder',{'responderLabel':'Network Operations'})
    act('transitions',{'status':'Investigating'})
    note_cmd,note_receipt=act('notes',{'text':'  Reviewing Zone A congestion.\nChecking recovery.  '})
    assert note_receipt['event']['text']=='Reviewing Zone A congestion.\nChecking recovery.'
    before_recovery=detail();reset();poll('telemetry recovered without resolving response',healthy)
    assert detail()==before_recovery and detail()['status']=='Investigating'
    act('transitions',{'status':'Monitoring','note':'Telemetry recovered; observing.'})
    act('notes',{'text':'Measurements remain stable.'})
    _,resolution=act('transitions',{'status':'Resolved','note':'Stable after load decreased.'})
    assert detail()['resolvedAtUtc']==resolution['event']['occurredAtUtc']
    act('notes',{'text':'Follow-up review complete.'})
    conflict=submit(command('responder',{'responderLabel':'Other team'}),409);assert conflict['code']=='state_conflict'
    for target in ['Open','Monitoring','Resolved']:
        assert submit(command('transitions',{'status':target,'note':'Follow-up'}),409)['code']=='state_conflict'
    before_restart=detail();save('resolved-before-restart.json',before_restart)
    run('docker','restart',api_name);refresh_api_address();poll('temporary API restarted',lambda: request(base+'/health/ready/incidents')[0]==200)
    assert detail()==before_restart
    submit(command('transitions',{'status':'Investigating','note':'   '}),400)
    act('transitions',{'status':'Investigating','note':'Reassessing a related concern.'})
    assert detail()['resolvedAtUtc'] is None and resolution['event'] in detail()['events']
    assert detail()['monitoringEvidence']==original['monitoringEvidence']
    checks.append('responder/null contract; investigation; telemetry-independent recovery; monitoring; resolution; follow-up; restart; reopening');log(checks[-1])

    state=detail();n=state['version']
    candidates=[command('notes',{'text':'Concurrent investigation A'},n),command('notes',{'text':'Concurrent investigation B'},n)]
    results=race(candidates);assert sorted(r[0] for r in results)==[200,409],results
    winner=next(i for i,r in enumerate(results) if r[0]==200);loser=1-winner
    assert results[loser][1]['code']=='version_conflict'
    assert detail()['version']==n+1 and len(timeline())==n+1
    assert sql(f'''SELECT count(*) FROM "IncidentEvents" WHERE "CommandId"='{candidates[loser][2]['commandId']}';''')=='0'
    assert submit(candidates[winner])==results[winner][1]
    conflicting=(candidates[winner][0],candidates[winner][1],dict(candidates[winner][2],text='Changed intent'))
    assert submit(conflicting,409)['code']=='command_conflict'
    duplicate=command('notes',{'text':'Concurrent identical retry'})
    identical=race([duplicate,duplicate]);assert [r[0] for r in identical]==[200,200] and identical[0][1]==identical[1][1],identical
    assert detail()['version']==n+2 and len(timeline())==n+2
    # A previously rejected ID is unreserved, and can carry a newly reviewed command.
    reviewed=command('notes',{'text':'Reviewed after conflict'},command_id=candidates[loser][2]['commandId']);submit(reviewed)
    assert submit(note_cmd)==note_receipt
    for changed in [dict(note_cmd[2],text='Different'),dict(note_cmd[2],expectedVersion=detail()['version'])]:
        assert submit((note_cmd[0],note_cmd[1],changed),409)['code']=='command_conflict'
    assert submit(('transitions','POST',{'commandId':note_cmd[2]['commandId'],'expectedVersion':note_cmd[2]['expectedVersion'],'status':'Monitoring'}),409)['code']=='command_conflict'
    assert submit(('responder','PUT',dict(clear_cmd[2],responderLabel='Different')),409)['code']=='command_conflict'
    save('concurrency.json',{'different':results,'identical':identical});checks.append('real overlapping version conflict; identical concurrent retry; immutable receipts; committed-key conflict; rejected IDs unreserved');log(checks[-1])

    before=detail();sql('''CREATE FUNCTION fail_workflow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."Kind" <> 'Created' THEN RAISE EXCEPTION 'intentional workflow rollback'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fail_workflow BEFORE INSERT ON "IncidentEvents" FOR EACH ROW EXECUTE FUNCTION fail_workflow();''')
    failed=command('transitions',{'status':'Resolved','note':'Attempt must roll back.'})
    submit(failed,503);assert detail()==before
    assert sql(f'''SELECT count(*) FROM "IncidentEvents" WHERE "CommandId"='{failed[2]['commandId']}';''')=='0'
    sql('DROP TRIGGER fail_workflow ON "IncidentEvents"; DROP FUNCTION fail_workflow();')
    act('notes',{'text':'Storage recovered; investigation continues.'})
    checks.append('forced event insertion failure atomically rolls back status/resolution/version and reserves no ID');log(checks[-1])

    samples=[];stop=threading.Event()
    def observe_details():
        while not stop.is_set():
            value=detail();seq=[e['sequence'] for e in value['events']]
            assert seq and max(seq)==value['version'] and all(s<=value['version'] for s in seq)
            samples.append({'version':value['version'],'maxSequence':max(seq)})
            stop.wait(.01)
    with ThreadPoolExecutor(max_workers=1) as pool:
        observer=pool.submit(observe_details)
        try:
            for n in range(105):act('notes',{'text':f'Bounded chronology verification {n}'})
        finally:
            stop.set()
        observer.result(timeout=15)
    all_events=timeline();assert len(all_events)>100 and all_events[0]==created_event and resolution['event'] in all_events
    assert len(detail()['events'])==100 and detail()['hasEarlierEvents']
    assert note_receipt['event'] not in detail()['events'] and submit(note_cmd)==note_receipt
    assert request(base+'/health/ready/incidents')[0]==200
    save('timeline.json',all_events);save('concurrent-detail-observations.json',samples)
    checks.append('HTTP-created >100 events; complete cursor traversal; version-fenced concurrent detail; old receipt outside newest page');log(checks[-1])

    remove_api();start_api(current_image,'http://127.0.0.1:1')
    assert detail()['monitoringEvidence']==original['monitoringEvidence']
    act('notes',{'text':'Stored workflow remains available without Prometheus.'})
    act('responder',{'responderLabel':None});act('responder',{'responderLabel':'Response team'})
    act('transitions',{'status':'Monitoring'})
    act('transitions',{'status':'Resolved','note':'Human response complete while monitoring dependency is unavailable.'})
    act('transitions',{'status':'Investigating','note':'Follow-up investigation.'})
    expect(base+'/api/incidents',503,'POST',create_body)
    checks.append('all stored workflow commands work without Prometheus; new capture creation 503');log(checks[-1])

    remove_api();start_api(current_image)
    before=detail();db_commands=[command('notes',{'text':'Unavailable'}),command('transitions',{'status':'Monitoring'}),command('responder',{'responderLabel':None})]
    started=json.loads(run('docker','inspect',api_name).stdout)[0]['State']['StartedAt']
    sql(f'ALTER ROLE {identifier} NOLOGIN;','postgres')
    sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{identifier}' AND pid<>pg_backend_pid();",'postgres')
    assert request(base+'/health/live')[0]==200
    expect(base+'/api/operations/overview');assert request(base+'/health/ready/incidents')[0]==503
    expect(base+'/api/incidents/'+str(incident_id),503)
    for cmd in db_commands:submit(cmd,503)
    expect(base+'/api/incidents',503,'POST',create_body)
    assert json.loads(run('docker','inspect',api_name).stdout)[0]['State']['StartedAt']==started
    sql(f'ALTER ROLE {identifier} LOGIN;','postgres')
    poll('isolated database access recovered',lambda: request(base+'/health/ready/incidents')[0]==200)
    assert detail()==before and submit(note_cmd)==note_receipt
    act('notes',{'text':'Database access restored.'})
    checks.append('database failure isolated from process liveness/monitoring; bounded 503; prior state and receipt recover');log(checks[-1])
    assert detail()['monitoringEvidence']==original['monitoringEvidence'] and timeline()[0]==created_event
    save('final-incident.json',detail());save('results.json',{'checks':checks,'incidentId':incident_id,'eventCount':detail()['version'],'legacyImage':legacy_image,'currentImage':current_image})
finally:
    errors=[]
    release_lock()
    if mutated:
        try:
            reset();poll('cleanup: exact baseline and inactive alerts',healthy)
        except Exception as error:errors.append(str(error))
    try:
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
            assert expect(history_url)==history
            save('history-after.json',expect(history_url))
            assert sql('SELECT (SELECT count(*) FROM "Incidents"),(SELECT count(*) FROM "IncidentAccessPoints"),(SELECT count(*) FROM "IncidentEvents");','venueops_incidents')==normal_counts
    except Exception as error:errors.append('preservation: '+str(error))
    save('cleanup.json',{'errors':errors,'isolatedResourcesRemoved':not errors,'temporaryCredentialsRemoved':not env_file.exists()})
    if errors:raise AssertionError('Cleanup/preservation failed: '+repr(errors))
log('PASS: Task 2 real PostgreSQL workflow and chronology')
print('Evidence: '+str(evidence),flush=True)
PY
