#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - "$@" <<'PY'
"""Hosted Task 1 proof. Uses the built API image and the existing Venue PostgreSQL service."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--evidence-dir')
args = parser.parse_args()
evidence = Path(args.evidence_dir or tempfile.mkdtemp(prefix='venue-m6-evidence-')).resolve()
root = Path.cwd().resolve()
if evidence == root or root in evidence.parents:
    raise SystemExit('Evidence must be outside the repository.')
evidence.mkdir(parents=True, exist_ok=True)
project = 'venue-network-operations-console'
network = project + '_default'
api_image = project + '-venue-api'
db_container = project + '-incident-db-1'
api_name = project + '-m6-verify-api'
migration_name = project + '-m6-verify-migration'
identifier = 'venueops_m6_verify_' + secrets.token_hex(6)
assert re.fullmatch(r'venueops_m6_verify_[0-9a-f]{12}', identifier)
password = secrets.token_hex(32)
temporary = tempfile.TemporaryDirectory(prefix='venue-m6-credentials-')
env_file = Path(temporary.name) / 'api.env'
owned_api = owned_migration = owned_database = owned_role = mutated = False
base = ''
checks = []


def log(message):
    print(datetime.datetime.now(datetime.timezone.utc).isoformat(), message, flush=True)


def run(*command, input=None, timeout=60, check=True):
    result = subprocess.run(command, input=input, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(f'{command[0]} failed: {(result.stderr or result.stdout).replace(password, "<redacted>")}')
    return result


def sql(statement, database='postgres'):
    return run('docker', 'exec', '-i', db_container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
               '-U', 'venueops', '-d', database, '-At', input=statement).stdout.strip()


def save(name, value):
    (evidence / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


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
    if status == 503:
        assert elapsed < 12, ('unbounded dependency error', elapsed)
        assert isinstance(value, dict) and value['status'] == 503, value
        assert 'application/problem+json' in headers.get('Content-Type', ''), headers
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
        time.sleep(1)
    raise AssertionError('Timed out: ' + label)


def reset():
    expect('http://127.0.0.1:8081/simulation/event-day/reset', method='POST')


def healthy():
    value = expect('http://127.0.0.1:8080/api/operations/overview')
    aps = value['accessPoints']
    expected = [(42,.55,.018,.002),(35,.48,.016,.001),(28,.41,.015,.001),(31,.46,.017,.002)]
    return value if all(ap['operational'] and not ap['degraded'] and ap['alertState'] == ap['degradationAlertState'] == 'inactive'
        and (ap['clients'],ap['channelUtilizationRatio'],ap['managementLatencySeconds'],ap['managementPacketLossRatio']) == metrics
        for ap, metrics in zip(aps,expected,strict=True)) and value['probe']['success'] and value['simulatorScrape']['up'] else None


def context_matches(snapshot, observed):
    for field in ['apId','zone','operational','degraded','clients','channelUtilizationRatio',
                  'managementLatencySeconds','managementPacketLossRatio','alertState','degradationAlertState','source']:
        assert snapshot[field] == observed[field], (field,snapshot,observed)


def start_api(prometheus='http://prometheus:9090'):
    global owned_api, base
    env_file.write_text(f'Incidents__Host=incident-db\nIncidents__Database={identifier}\nIncidents__Username={identifier}\nIncidents__Password={password}\nPrometheus__BaseUrl={prometheus}\n')
    env_file.chmod(0o600)
    owned_api = True
    run('docker','run','--detach','--pull','never','--name',api_name,'--network',network,
        '--publish','127.0.0.1::8080','--env-file',str(env_file),api_image)
    refresh_api_address()
    poll('isolated API live', lambda: request(base+'/health/live')[0] == 200)


def refresh_api_address():
    global base
    # Docker may allocate a different temporary host port after container restart.
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


def migrate(label):
    global owned_migration
    owned_migration = True
    result = run('docker','run','--rm','--pull','never','--name',migration_name,'--network',network,
                 '--env-file',str(env_file),api_image,'--migrate-incidents')
    owned_migration = False
    (evidence/(label+'.log')).write_text((result.stdout+result.stderr).replace(password,'<redacted>'))


def counts():
    return sql('SELECT (SELECT count(*) FROM "Incidents"), (SELECT count(*) FROM "IncidentAccessPoints"), (SELECT count(*) FROM "IncidentEvents");',identifier)


def created(body, name):
    code,value,headers,_ = request(base+'/api/incidents','POST',body)
    assert code == 201, (code,value)
    assert headers['Location'] == '/api/incidents/'+str(value['id'])
    assert value['number'] == f'INC-{value["id"]:06d}'
    assert value['status'] == 'Open'
    assert len(value['events']) == 1 and value['events'][0]['kind'] == 'Created'
    assert value['createdAtUtc'] == value['events'][0]['occurredAtUtc']
    assert expect(base+headers['Location']) == value
    save(name,value)
    return value


def stop_signal(signum, frame):
    raise KeyboardInterrupt('Verification interrupted')


signal.signal(signal.SIGTERM,stop_signal)
signal.signal(signal.SIGINT,stop_signal)
try:
    for name in [api_name,migration_name]:
        assert run('docker','container','inspect',name,check=False).returncode != 0, 'Refusing existing resource: '+name
    info = json.loads(run('docker','inspect',db_container).stdout)[0]
    assert info['Config']['Image'] == 'postgres:18.6-alpine3.23'
    assert not any(info['NetworkSettings']['Ports'].values()), 'Normal PostgreSQL must not be published'
    assert info['State']['Health']['Status'] == 'healthy'
    assert not sql(f"SELECT 1 FROM pg_database WHERE datname='{identifier}';")
    assert not sql(f"SELECT 1 FROM pg_roles WHERE rolname='{identifier}';")
    owned_role = True
    sql(f'CREATE ROLE {identifier} LOGIN PASSWORD \'{password}\';')
    owned_database = True
    sql(f'CREATE DATABASE {identifier} OWNER {identifier};')
    start_api()
    assert request(base+'/health/ready/incidents')[0] == 503
    assert sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';",identifier) == '0', 'Startup created schema'
    expect(base+'/api/operations/overview')
    migrate('migration-first')
    before = sql('SELECT * FROM "__EFMigrationsHistory";',identifier)
    assert before and counts() == '0|0|0'
    migrate('migration-repeat')
    assert sql('SELECT * FROM "__EFMigrationsHistory";',identifier) == before
    assert counts() == '0|0|0'
    assert request(base+'/health/ready/incidents')[0] == 200
    checks.append('explicit migration; startup independence; repeat migration no-op')
    log(checks[-1])

    # Cleanup is already registered before any simulator mutation.
    mutated = True
    reset()
    poll('collected exact baseline',healthy)
    offline = {'title':'Single AP outage verification','accessPoints':[{'apId':'ap-001','expectedCondition':'offline'}]}
    expect(base+'/api/incidents',409,'POST',offline)
    for bad in [dict(offline,title=''),dict(offline,zone='zone-a'),dict(offline,accessPoints=[]),
                dict(offline,accessPoints=[offline['accessPoints'][0]]*2),
                dict(offline,accessPoints=[{'apId':'ap-999','expectedCondition':'offline'}]),
                dict(offline,accessPoints=[{'apId':'ap-001','expectedCondition':'offline'},{'apId':'ap-003','expectedCondition':'offline'}])]:
        expect(base+'/api/incidents',400,'POST',bad)
    expect(base+'/api/incidents/999999',404)
    assert request(base+'/api/incidents')[0] == 405, 'List endpoint is not Task 1'
    assert counts() == '0|0|0'
    expect('http://127.0.0.1:8081/simulation/access-points/ap-001',method='PUT',body={'scenario':'offline'})
    def outage():
        overview=expect('http://127.0.0.1:8080/api/operations/overview')
        return overview if not overview['accessPoints'][0]['operational'] and overview['accessPoints'][0]['alertState']=='firing' else None
    observed=poll('collected offline condition and actual AP-down alert',outage)
    sql('''CREATE FUNCTION fail_created() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional verification rollback'; END $$;
CREATE TRIGGER fail_created BEFORE INSERT ON "IncidentEvents" FOR EACH ROW EXECUTE FUNCTION fail_created();''',identifier)
    expect(base+'/api/incidents',503,'POST',offline)
    assert counts() == '0|0|0', 'Incident graph partially committed'
    sql('DROP TRIGGER fail_created ON "IncidentEvents"; DROP FUNCTION fail_created();',identifier)
    checks.append('forced Created-event failure rolls back incident and AP context')
    a=created(offline,'single-ap.json')
    assert a['zone']=='zone-a'
    ap=a['monitoringEvidence']['accessPoints'][0]
    context_matches(ap,observed['accessPoints'][0])
    assert ap['clients']==0 and all(ap[k] is None for k in ['channelUtilizationRatio','managementLatencySeconds','managementPacketLossRatio'])
    assert ap['downAlert']['name']=='VenueApDown' and ap['downAlert']['severity']=='critical'
    assert ap['downAlert']['telemetrySource']=='simulated'
    reset();poll('single AP recovered',healthy)
    assert expect(base+'/api/incidents/'+str(a['id']))==a
    checks.append('single AP outage evidence survives monitoring recovery')
    log(checks[-1])

    expect('http://127.0.0.1:8081/simulation/event-day/position',method='PUT',body={'elapsedMinutes':360})
    def peak():
        overview=expect('http://127.0.0.1:8080/api/operations/overview')
        aps=overview['accessPoints']
        return overview if all(ap['operational'] for ap in aps) and all(ap['degraded'] and ap['degradationAlertState']=='firing' for ap in aps[:2]) else None
    observed=poll('collected Zone A peak and actual degradation warnings',peak)
    b=created({'title':'Zone A degradation verification','responderLabel':'Verification team',
        'accessPoints':[{'apId':ap,'expectedCondition':'degraded'} for ap in ['ap-001','ap-002']]},'multi-ap.json')
    contexts=b['monitoringEvidence']['accessPoints']
    assert b['zone']=='zone-a' and [ap['apId'] for ap in contexts]==['ap-001','ap-002']
    for ap,live in zip(contexts,observed['accessPoints'][:2],strict=True):
        context_matches(ap,live)
        assert ap['degradationAlert']['name']=='VenueApDegraded'
        assert ap['degradationAlert']['severity']=='warning' and ap['degradationAlert']['telemetrySource']=='simulated'
    assert counts()=='2|3|2'
    reset();poll('multi-AP condition recovered and alerts cleared',healthy)
    assert expect(base+'/api/incidents/'+str(b['id']))==b
    checks.append('multi-AP same-zone snapshot survives event reset')
    log(checks[-1])

    run('docker','restart',api_name)
    refresh_api_address()
    poll('API restarted with same database',lambda: request(base+'/health/ready/incidents')[0]==200)
    for incident in [a,b]:
        assert expect(base+'/api/incidents/'+str(incident['id']))==incident
    checks.append('API process restart preserves complete incident representations')
    log(checks[-1])

    remove_api();start_api('http://127.0.0.1:1')
    for incident in [a,b]:
        assert expect(base+'/api/incidents/'+str(incident['id']))==incident
    expect(base+'/api/incidents',503,'POST',offline)
    assert counts()=='2|3|2'
    checks.append('stored GET independent of Prometheus; capture POST 503')
    log(checks[-1])

    remove_api();start_api()
    expect(base+'/api/operations/overview')
    process_before=json.loads(run('docker','inspect',api_name).stdout)[0]['State']['StartedAt']
    sql(f'ALTER ROLE {identifier} NOLOGIN;')
    sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{identifier}' AND pid<>pg_backend_pid();")
    assert request(base+'/health/live')[0]==200
    expect(base+'/api/operations/overview')
    assert request(base+'/health/ready/incidents')[0]==503
    expect(base+'/api/incidents/'+str(a['id']),503)
    expect(base+'/api/incidents',503,'POST',offline)
    assert json.loads(run('docker','inspect',api_name).stdout)[0]['State']['StartedAt']==process_before
    sql(f'ALTER ROLE {identifier} LOGIN;')
    poll('incident dependency recovered',lambda: request(base+'/health/ready/incidents')[0]==200)
    assert expect(base+'/api/incidents/'+str(a['id']))==a
    checks.append('database unavailable: same live API, usable monitoring, bounded incident 503, successful recovery')
    log(checks[-1])
    assert counts()=='2|3|2'
    save('results.json',{'checks':checks,'database':identifier,'incidentIds':[a['id'],b['id']], 'rowCounts':counts()})
finally:
    cleanup_errors=[]
    if mutated:
        try:
            reset();poll('cleanup: exact baseline and inactive alerts',healthy)
        except Exception as error:
            cleanup_errors.append(str(error))
    try:
        remove_api()
        if owned_migration:
            run('docker','rm','--force',migration_name,check=False)
        if owned_database:
            sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{identifier}' AND pid<>pg_backend_pid();")
            sql(f'DROP DATABASE {identifier};')
        if owned_role:
            sql(f'DROP ROLE {identifier};')
    except Exception as error:
        cleanup_errors.append(str(error))
    temporary.cleanup()
    save('cleanup.json',{'errors':cleanup_errors,'isolatedDatabaseRemoved':not cleanup_errors})
    if cleanup_errors:
        raise AssertionError('Cleanup failed: '+repr(cleanup_errors))
log('PASS: Task 1 real PostgreSQL / EF / HTTP persistence viability')
print('Evidence: '+str(evidence),flush=True)
PY
