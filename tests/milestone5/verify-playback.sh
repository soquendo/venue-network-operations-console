#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Requires the maintained Node 22 environment and the already-running Venue stack.
# Full mode also requires the existing frontend at 127.0.0.1:5173 and installed Chrome.
node --input-type=module - "$@" <<'NODE'
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const mode = option('--mode');
assert(['smoke', 'restart', 'failure', 'full'].includes(mode), 'Use --mode smoke|restart|failure|full and optionally --evidence-dir PATH');
assert.equal(process.versions.node.split('.')[0], '22', 'Use the maintained Node 22 environment');
const evidence = resolve(option('--evidence-dir') ?? await mkdtemp(join(tmpdir(), 'venue-playback-')));
await mkdir(evidence, { recursive: true });
const SIM = 'http://127.0.0.1:8081';
const API = 'http://127.0.0.1:8080';
const PROM = 'http://127.0.0.1:9090';
const ids = ['ap-001', 'ap-002', 'ap-003', 'ap-004'];
const fields = ['clients', 'channelUtilizationRatio', 'managementLatencySeconds', 'managementPacketLossRatio'];
const families = ['venue_ap_clients', 'venue_ap_channel_utilization_ratio', 'venue_ap_management_latency_seconds', 'venue_ap_management_packet_loss_ratio'];
const phases = [[0, 'PRE_OPEN'], [150, 'ARRIVAL'], [240, 'BUILDING_LOAD'], [360, 'PEAK_DENSITY'], [480, 'RECOVERY'], [660, 'EVENT_CLOSE']];
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
process.on('SIGTERM', () => { interrupted = true; });
const save = (name, value) => writeFile(join(evidence, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
const log = message => console.log(`${new Date().toISOString()} ${message}`);
function near(actual, expected) {
  assert(actual !== null && Math.abs(Number(actual) - expected) < 1e-12, `${actual} != ${expected}`);
}
async function request(base, path, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${text}`);
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  if (method !== 'GET') await appendFile(join(evidence, 'commands.jsonl'), JSON.stringify({ utc: new Date().toISOString(), method, path, body, status: response.status, result }) + '\n');
  return result;
}
async function wait(label, check, timeout = 30000, cleanup = false) {
  const deadline = performance.now() + timeout;
  let last;
  while (performance.now() < deadline) {
    if (interrupted && !cleanup) throw new Error('Verification interrupted');
    try { const value = await check(); log(`PASS: ${label}`); return value; }
    catch (error) { last = error; }
    await delay(500);
  }
  throw new Error(`${label}: ${last}`);
}
function profile(minute) {
  // Preserve the accepted decimal interpolation, including rounding before client midpoints.
  const scale = 10n ** 28n, maxDecimal = (1n << 96n) - 1n;
  const round = (n, d, away = false) => {
    const sign = n < 0n ? -1n : 1n, magnitude = n * sign, q = magnitude / d, r = magnitude % d;
    return sign * (q + (2n * r > d || (2n * r === d && (away || q % 2n === 1n)) ? 1n : 0n));
  };
  const knots = [[0, 0n], [150, scale / 4n], [240, scale / 2n], [360, scale], [480, scale], [660, 0n]];
  const index = Math.min(4, knots.findLastIndex(([m]) => minute >= m));
  const [left, load] = knots[index], [right, next] = knots[index + 1];
  const progress = round(BigInt(minute - left) * scale, BigInt(right - left));
  const normalized = load + round(progress * (next - load), scale);
  return ids.map((apId, i) => {
    const decimalPressure = i < 2 ? normalized : round(normalized, 2n);
    const pressure = Number(decimalPressure) / Number(scale);
    const product = BigInt([42, 35, 28, 31][i]) * (scale + decimalPressure);
    let divisor = 1n;
    while (round(product, divisor) > maxDecimal) divisor *= 10n;
    const clients = Number(round(round(product, divisor), scale / divisor, true));
    const utilization = [.55, .48, .41, .46][i] + .40 * pressure;
    return { apId, zone: i < 2 ? 'zone-a' : 'zone-b', operational: true, clients,
      channelUtilizationRatio: utilization,
      managementLatencySeconds: [.018, .016, .015, .017][i] + .20 * Math.max(0, utilization - .65),
      managementPacketLossRatio: [.002, .001, .001, .002][i] + .10 * Math.max(0, utilization - .80) };
  });
}
function assertMeasurements(aps, minute, overrides = false) {
  assert.deepEqual(aps.map(a => a.apId), ids);
  const expected = profile(minute);
  for (const [i, ap] of aps.entries()) {
    assert.equal(ap.zone, expected[i].zone);
    if (overrides && ap.scenario === 'offline') {
      assert.equal(ap.operational, false); assert.equal(ap.clients, 0);
      for (const field of fields.slice(1)) assert.equal(ap[field], null);
    } else {
      assert.equal(ap.operational, true);
      for (const field of fields) near(ap[field], expected[i][field]);
    }
  }
}
function assertStatus(state, expectedMode, expectedMinute) {
  assert.equal(state.scenario, 'High-Density Event Day');
  if (expectedMode) assert.equal(state.mode, expectedMode);
  if (expectedMinute !== undefined) assert.equal(state.elapsedMinutes, expectedMinute);
  const minute = state.elapsedMinutes ?? 0;
  assert(Number.isInteger(minute) && minute >= 0 && minute <= 660);
  assert.equal(state.phase, state.mode === 'baseline' ? null : phases.findLast(([m]) => minute >= m)[1]);
  const p = minute < 150 ? minute / 600 : minute < 240 ? (minute - 60) / 360
    : minute < 360 ? (minute - 120) / 240 : minute < 480 ? 1 : (660 - minute) / 180;
  near(state.normalizedLoad, p);
  assertMeasurements(state.accessPoints, minute, true);
  return state;
}
const status = () => request(SIM, '/simulation/event-day');
const put = minute => request(SIM, '/simulation/event-day/position', 'PUT', { elapsedMinutes: minute });
const quality = ap => ap.operational && ap.channelUtilizationRatio >= .80
  && (ap.managementLatencySeconds >= .050 || ap.managementPacketLossRatio >= .010);
async function rules() {
  const body = await request(PROM, '/api/v1/rules');
  const rows = body.data.groups.flatMap(g => g.rules);
  const down = rows.find(r => r.name === 'VenueApDown');
  const warning = rows.find(r => r.name === 'VenueApDegraded');
  assert(rows.every(r => r.health === 'ok'));
  assert.equal(down.state, 'inactive'); assert.equal(down.duration, 10);
  assert.equal(warning.duration, 30);
  assert.deepEqual(warning.labels, { severity: 'warning', telemetry_source: 'simulated' });
  assert(warning.alerts.every(a => ids.slice(0, 2).includes(a.labels.ap_id) && a.labels.zone === 'zone-a'));
  return warning;
}
async function overview() {
  const body = await request(API, '/api/operations/overview');
  assert.equal(body.simulatorScrape.up, true);
  assert.equal(body.probe.success, true); assert.equal(body.probe.httpStatusCode, 200);
  assert.deepEqual(body.accessPoints.map(a => a.apId), ids);
  for (const ap of body.accessPoints) {
    assert.equal(ap.operational, true); assert.equal(ap.alertState, 'inactive');
    assert.equal(ap.degraded, quality(ap));
  }
  assert.deepEqual(body.zones.map(z => z.operationalRatio), [1, 1]);
  for (const zone of body.zones) assert.equal(zone.degradedAccessPoints, body.accessPoints.filter(a => a.zone === zone.zone && a.degraded).length);
  return body;
}
function parseMetrics(text) {
  const aps = new Map(ids.map((apId, i) => [apId, { apId, zone: i < 2 ? 'zone-a' : 'zone-b' }]));
  let count = 0;
  for (const line of text.split('\n')) {
    const match = /^(venue_ap_\w+)\{([^}]+)\} (\S+)$/.exec(line);
    if (!match) continue;
    const labels = Object.fromEntries([...match[2].matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const ap = aps.get(labels.ap_id); assert(ap); assert.equal(labels.zone, ap.zone);
    if (match[1] === 'venue_ap_operational') ap.operational = Number(match[3]) === 1;
    else { const index = families.indexOf(match[1]); assert(index >= 0); ap[fields[index]] = Number(match[3]); }
    count++;
  }
  assert.equal(count, 20);
  return [...aps.values()];
}
async function reset(cleanup = false) {
  await wait('reset control available', async () => assertStatus(await request(SIM, '/simulation/event-day/reset', 'POST'), 'baseline', null), 30000, cleanup);
  const body = await wait('collected exact baseline, healthy monitoring and inactive alerts', async () => {
    const current = await overview(); assertMeasurements(current.accessPoints, 0);
    assert.deepEqual(current.zones.map(z => z.clients), [77, 59]);
    assert(current.accessPoints.every(a => !a.degraded && a.degradationAlertState === 'inactive'));
    assert.equal((await rules()).state, 'inactive');
    assertMeasurements(parseMetrics(await request(SIM, '/metrics')), 0);
    return current;
  }, 30000, cleanup);
  return body;
}
async function start() {
  const before = performance.now(), utcBefore = Date.now();
  const body = await request(SIM, '/simulation/event-day/start', 'POST');
  const after = performance.now(), utcAfter = Date.now();
  assertStatus(body, 'running', 0);
  assert(body.accessPoints.every(a => a.scenario === 'healthy'));
  log('PASS: start returns exact running minute 0 and healthy overrides');
  return { before, after, utcBefore, utcAfter };
}
async function runningStatus(anchor) {
  const before = performance.now(); const body = await status(); const after = performance.now();
  assertStatus(body, body.elapsedMinutes === 660 ? 'completed' : 'running');
  // Host and container monotonic clocks are independent; exact edges belong to unit tests.
  const low = Math.min(660, Math.max(0, Math.floor((before - anchor.after) / 1000) - 1));
  const high = Math.min(660, Math.floor((after - anchor.before) / 1000) + 1);
  assert(body.elapsedMinutes >= low && body.elapsedMinutes <= high, `clock position ${body.elapsedMinutes} outside request bounds ${low}..${high}`);
  return body;
}
async function stable(label, mode, minute, seconds = 10) {
  const original = assertStatus(await status(), mode, minute);
  const began = performance.now(); let count = 0;
  do {
    if (interrupted) throw new Error('Verification interrupted');
    assert.deepEqual(await status(), original);
    assertMeasurements(parseMetrics(await request(SIM, '/metrics')), minute ?? 0);
    count++; await delay(1000);
  } while (performance.now() - began < seconds * 1000);
  log(`PASS: ${label} stable for ${(performance.now() - began) / 1000}s (${count} observations)`);
  return original;
}

let chrome, chromeLog, socket, sessionId, sequence = 0;
const calls = new Map(), network = new Map();
const stats = Object.fromEntries(['overview', 'history'].map(k => [k, { count: 0, active: 0, maxActive: 0, last: null, minSpacingMs: null }]));
let browserError;
function cdp(method, params = {}, root = false) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    calls.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(root ? {} : { sessionId }) }));
  });
}
async function browserOpen() {
  const profileDir = await mkdtemp(join(evidence, 'chrome-'));
  chromeLog = await open(join(evidence, 'chrome.log'), 'w');
  chrome = spawn(process.env.VENUE_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', chromeLog.fd, chromeLog.fd] });
  chrome.on('error', error => { browserError = error; });
  const active = await wait('isolated browser ready', async () => { if (browserError) throw browserError; return (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); });
  socket = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), call = calls.get(message.id);
    if (call) { clearTimeout(call.timeout); calls.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result); }
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request } = message.params;
      const kind = request.url.includes('/api/operations/overview') ? 'overview' : /\/api\/operations\/access-points\/[^/]+\/history/.test(request.url) ? 'history' : null;
      if (kind && !network.has(requestId)) {
        network.set(requestId, kind); const s = stats[kind], now = performance.now();
        s.count++; s.active++; s.maxActive = Math.max(s.maxActive, s.active);
        if (s.last !== null) s.minSpacingMs = Math.min(s.minSpacingMs ?? Infinity, now - s.last);
        s.last = now;
      }
    }
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      const kind = network.get(message.params.requestId);
      if (kind) { stats[kind].active--; network.delete(message.params.requestId); }
    }
  });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' }, true);
  ({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }, true));
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5173/' }); await cdp('Page.bringToFront');
}
async function browserSnapshot() {
  const response = await cdp('Runtime.evaluate', { returnByValue: true, expression: `(() => ({
    title:document.querySelector('h1')?.textContent,
    zones:[...document.querySelectorAll('.zone-card')].map(e=>({status:e.querySelector('.status-badge').textContent,values:[...e.querySelectorAll('dd')].map(x=>x.textContent)})),
    aps:[...document.querySelectorAll('[aria-labelledby="aps-heading"] tbody tr')].map(e=>({id:e.querySelector('th').textContent,status:e.querySelector('.status-badge').textContent,clients:Number(e.querySelectorAll('td')[2].textContent),values:[...e.querySelectorAll('td')].map(x=>x.textContent),alerts:[...e.querySelectorAll('.alert-state')].map(x=>x.textContent)})),
    summary:[...document.querySelectorAll('.history-summary > div')].map(e=>e.textContent),
    recent:[...document.querySelectorAll('.history-section tbody tr')].map(e=>[...e.children].map(x=>x.textContent)),
    cells:[...document.querySelectorAll('.state-timeline span')].map(e=>({state:e.className,left:e.style.left,width:e.style.width,title:e.title})),
    errors:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent)
  }))()` });
  assert.equal(response.exceptionDetails, undefined); const s = response.result.value;
  assert.equal(s.title, 'Venue Network Operations Console'); assert.deepEqual(s.errors, []);
  assert.deepEqual(s.aps.map(a => a.id), ids);
  assert(s.aps.every(a => a.alerts[0] === 'inactive' && a.status !== 'Offline'));
  assert.equal(s.zones.length, 2); assert.equal(s.zones[1].status, 'Healthy');
  return s;
}
async function screenshot(name, snapshot) {
  await save(name, snapshot);
  const layout = await cdp('Page.getLayoutMetrics');
  const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: layout.cssContentSize.width, height: layout.cssContentSize.height, scale: 1 } });
  await writeFile(join(evidence, `${name}.png`), Buffer.from(image.data, 'base64'));
}
async function fullRun() {
  await browserOpen();
  const initialUi = await wait('frontend baseline', async () => { const s = await browserSnapshot(); assert.deepEqual(s.aps.map(a => a.clients), [42, 35, 28, 31]); assert(s.recent.length); return s; });
  await screenshot('baseline-ui', initialUi);
  const anchor = await start(); await save('run-anchor', anchor);
  const seenPhases = {}, crossings = {}, alertEvents = {}, uiEvents = {}, apiEvents = {};
  const initialTransitions = Number(initialUi.summary.find(s => s.startsWith('State changes')).slice('State changes'.length));
  const deadlines = { 'ap-001:pending': 296, 'ap-001:firing': 336, 'ap-001:inactive': 564,
    'ap-002:pending': 344, 'ap-002:firing': 384, 'ap-002:inactive': 528 };
  const expectedCrossings = { 'ap-001:degraded': 276, 'ap-002:degraded': 324, 'ap-002:healthy': 508, 'ap-001:healthy': 544 };
  let nextMonitor = 0, lastReport = -60, completed;
  while (performance.now() - anchor.after < 720000) {
    if (interrupted) throw new Error('Verification interrupted');
    const state = await runningStatus(anchor);
    assert(state.accessPoints.every(a => a.operational && a.scenario === 'healthy'));
    const elapsed = (performance.now() - anchor.after) / 1000;
    if (!(state.phase in seenPhases)) {
      const expected = phases.find(([, p]) => p === state.phase)[0];
      assert(Math.abs(elapsed - expected) <= 5, `${state.phase} observed at ${elapsed}`);
      seenPhases[state.phase] = { elapsed, minute: state.elapsedMinutes };
      log(`PHASE: ${state.phase}, minute ${state.elapsedMinutes}, elapsed ${elapsed.toFixed(2)}s`);
    }
    for (const [key, at] of Object.entries(expectedCrossings)) {
      if (!crossings[key] && state.elapsedMinutes >= at) {
        const [ap, label] = key.split(':');
        assert.equal(quality(state.accessPoints[ids.indexOf(ap)]), label === 'degraded');
        assert(elapsed <= at + 5); crossings[key] = { elapsed, minute: state.elapsedMinutes };
        log(`CROSSING: ${key}, minute ${state.elapsedMinutes}, elapsed ${elapsed.toFixed(2)}s`);
      }
    }
    await appendFile(join(evidence, 'status.jsonl'), JSON.stringify({ elapsed, utc: new Date().toISOString(), state }) + '\n');
    if (elapsed >= nextMonitor) {
      nextMonitor = elapsed + 5;
      const current = await overview(), warning = await rules();
      const targets = await request(PROM, '/api/v1/targets');
      assert(targets.data.activeTargets.every(t => t.health === 'up' && t.lastError === ''), 'monitoring target unhealthy');
      for (const ap of current.accessPoints.slice(0, 2)) {
        const label = ap.degraded ? 'degraded' : 'healthy', key = `${ap.apId}:${label}`;
        if (apiEvents[key] === undefined && (ap.degraded || apiEvents[`${ap.apId}:degraded`] !== undefined)) {
          assert(elapsed >= expectedCrossings[key] - 1 && elapsed <= expectedCrossings[key] + 20, `API ${key} outside collection bounds`);
          apiEvents[key] = elapsed;
        }
      }
      const upper = await status();
      const metrics = parseMetrics(await request(SIM, '/METRICS/'));
      const afterMetrics = await status();
      let matches = false;
      for (let minute = upper.elapsedMinutes; minute <= afterMetrics.elapsedMinutes; minute++) {
        try { assertMeasurements(metrics, minute); matches = true; break; } catch (error) { if (!(error instanceof assert.AssertionError)) throw error; }
      }
      assert(matches, 'export mixed profile positions');
      for (const ap of ids.slice(0, 2)) {
        const alert = warning.alerts.find(a => a.labels.ap_id === ap);
        const alertState = alert?.state ?? 'inactive', key = `${ap}:${alertState}`;
        if (!alertEvents[key] && (alertState !== 'inactive' || alertEvents[`${ap}:firing`])) {
          const crossing = expectedCrossings[`${ap}:${alertState === 'inactive' ? 'healthy' : 'degraded'}`];
          assert(elapsed >= crossing - 1, `${key} appeared before its profile crossing`);
          assert(elapsed <= deadlines[key], `${key} missed observation bound`);
          if (alertState === 'firing') {
            assert(alertEvents[`${ap}:pending`], 'pending must be observed before firing');
            assert.equal(alert.activeAt, alertEvents[`${ap}:pending`].activeAt);
            assert(Date.parse(warning.lastEvaluation) - Date.parse(alert.activeAt) >= 29999, 'firing before sustained 30s');
          }
          alertEvents[key] = { elapsed, activeAt: alert?.activeAt, lastEvaluation: warning.lastEvaluation };
          log(`ALERT: ${key}, elapsed ${elapsed.toFixed(2)}s`);
        }
      }
      const ui = await browserSnapshot();
      for (const [i, ap] of ids.slice(0, 2).entries()) {
        const label = ui.aps[i].status === 'Degraded' ? 'degraded' : 'healthy';
        const key = `${ap}:${label}`;
        if (!uiEvents[key] && (label === 'degraded' || uiEvents[`${ap}:degraded`])) {
          assert(elapsed >= expectedCrossings[key] - 1 && elapsed <= expectedCrossings[key] + 20, `${key} UI outside collection bounds`);
          assert(ui.aps[i].clients > profile(0)[i].clients && ui.aps[i].clients < profile(360)[i].clients, 'crossing UI must display changing load measurements');
          uiEvents[key] = elapsed; await screenshot(`ui-${ap}-${label}`, ui);
        }
        if (ui.aps[i].alerts[1] === 'pending') uiEvents[`${ap}:warning-pending`] ??= elapsed;
        if (ui.aps[i].alerts[1] === 'firing') uiEvents[`${ap}:firing`] ??= elapsed;
        if (ui.aps[i].alerts[1] === 'inactive' && uiEvents[`${ap}:firing`] !== undefined && uiEvents[`${ap}:warning-cleared`] === undefined) {
          assert(elapsed <= expectedCrossings[`${ap}:healthy`] + 20);
          uiEvents[`${ap}:warning-cleared`] = elapsed;
        }
      }
      if (elapsed >= 380 && elapsed < 480 && uiEvents.peakMeasurements === undefined) {
        assert.deepEqual(ui.aps.map(a => a.clients), [84, 70, 42, 47]);
        assert.deepEqual(ui.aps.map(a => a.status), ['Degraded', 'Degraded', 'Healthy', 'Healthy']);
        assert.equal(ui.recent[0][1], 'Degraded'); assert.equal(ui.recent[0][2], '84');
        uiEvents.peakMeasurements = elapsed; await screenshot('peak-ui', ui);
      }
      assert.equal(ui.zones[0].status, ui.aps.slice(0, 2).some(a => a.status === 'Degraded') ? 'Degraded' : 'Healthy');
      assert.equal(Number(ui.zones[0].values[2]), ui.aps.slice(0, 2).filter(a => a.status === 'Degraded').length);
      const transitions = Number(ui.summary.find(s => s.startsWith('State changes')).slice('State changes'.length));
      assert(transitions <= initialTransitions, 'quality changes must not add availability transitions; older preflight transitions may expire');
      assert(ui.aps[2].status === 'Healthy' && ui.aps[3].status === 'Healthy');
      for (const s of Object.values(stats)) { assert(s.maxActive <= 1); assert(s.minSpacingMs === null || s.minSpacingMs >= 4500); }
      await appendFile(join(evidence, 'monitoring.jsonl'), JSON.stringify({ elapsed, utc: new Date().toISOString(), overview: current, warning, ui }) + '\n');
    }
    for (const [key, deadline] of Object.entries(deadlines)) if (elapsed > deadline) assert(alertEvents[key], `missing ${key} by ${deadline}s`);
    if (elapsed - lastReport >= 30) { log(`PROGRESS: ${elapsed.toFixed(1)}s, ${state.phase}, minute ${state.elapsedMinutes}`); lastReport = elapsed; }
    if (state.mode === 'completed') { completed = state; break; }
    await delay(1000);
  }
  assert(completed, 'automatic event did not complete within 720s');
  assert.equal(Object.keys(seenPhases).length, 6);
  assert.equal(Object.keys(crossings).length, 4);
  for (const key of Object.keys(deadlines)) assert(alertEvents[key], key);
  for (const key of Object.keys(expectedCrossings)) assert(uiEvents[key] !== undefined, `missing UI ${key}`);
  for (const key of Object.keys(expectedCrossings)) assert(apiEvents[key] !== undefined, `missing API ${key}`);
  for (const ap of ids.slice(0, 2)) for (const state of ['warning-pending', 'firing', 'warning-cleared']) assert(uiEvents[`${ap}:${state}`] !== undefined);
  assert(uiEvents.peakMeasurements !== undefined);
  await stable('completed EVENT_CLOSE', 'completed', 660);
  const endUi = await wait('completed frontend measurements and cleared warnings', async () => {
    const s = await browserSnapshot(); assert.deepEqual(s.aps.map(a => a.clients), [42, 35, 28, 31]);
    assert(s.aps.every(a => a.status === 'Healthy' && a.alerts[1] === 'inactive'));
    assert(s.cells.some(c => c.state === 'timeline-degraded')); return s;
  });
  await screenshot('completed-ui', endUi);
  const historyEvidence = {};
  for (const [i, ap] of ids.entries()) {
    const history = await request(API, `/api/operations/access-points/${ap}/history?window=15m`);
    assert.equal(history.stepSeconds, 5); assert.equal(history.window, '15m');
    const samples = history.samples.filter(s => Date.parse(s.observedAtUtc) >= anchor.utcAfter);
    assert(samples.length >= 125, 'insufficient collected run history');
    const timestamps = samples.map(s => Date.parse(s.observedAtUtc));
    assert(timestamps.every((t, j) => j === 0 || t > timestamps[j - 1]));
    assert(samples.every(s => s.operational && s.degraded === quality(s)));
    assert(samples.some(s => s.clients > profile(0)[i].clients && s.clients < profile(360)[i].clients), 'missing buildup');
    assert(samples.some(s => fields.every(f => Math.abs(s[f] - profile(360)[i][f]) < 1e-12)), 'missing peak plateau');
    if (i < 2) {
      const degraded = samples.filter(s => s.degraded); assert(degraded.length >= (i === 0 ? 48 : 31));
      const lastDegraded = Date.parse(degraded.at(-1).observedAtUtc);
      assert(samples.some(s => Date.parse(s.observedAtUtc) > lastDegraded && !s.degraded && s.clients > profile(0)[i].clients), 'missing recovered load');
    } else assert(samples.every(s => !s.degraded));
    for (const field of fields) near(samples.at(-1)[field], profile(660)[i][field]);
    assert.equal(samples.filter((s, j) => j && s.operational !== samples[j - 1].operational).length, 0);
    historyEvidence[ap] = { count: samples.length, degraded: samples.filter(s => s.degraded).length, first: samples[0].observedAtUtc, last: samples.at(-1).observedAtUtc };
    await save(`history-${ap}`, { ...history, samples });
  }
  await reset();
  await wait('reset rendered baseline', async () => { const s = await browserSnapshot(); assert.deepEqual(s.aps.map(a => a.clients), [42, 35, 28, 31]); assert(s.aps.every(a => a.status === 'Healthy' && a.alerts[1] === 'inactive')); });
  await save('full-summary', { anchor, phases: seenPhases, crossings, alerts: alertEvents, api: apiEvents, ui: uiEvents, history: historyEvidence, polling: stats, completed, resetVerified: true });
  log('PASS: full automatic event, alert timing, rendered polling, real history, stable completion and reset');
}

let failure;
try {
  await reset();
  if (mode === 'failure') {
    await start();
    await request(SIM, '/simulation/access-points/ap-001', 'PUT', { scenario: 'offline' });
    assert.equal((await status()).accessPoints[0].scenario, 'offline');
    throw new Error('Intentional failure after start and offline override to verify cleanup');
  }
  if (mode === 'smoke') {
    let anchor = await start();
    await wait('automatic minute advancement', async () => { const s = await runningStatus(anchor); assert(s.elapsedMinutes >= 2); return s; });
    await request(SIM, '/simulation/access-points/ap-001', 'PUT', { scenario: 'offline' });
    anchor = await start(); assert((await status()).accessPoints.every(a => a.operational));
    await request(SIM, '/simulation/access-points/ap-001', 'PUT', { scenario: 'offline' });
    for (const invalid of [{}, { elapsedMinutes: -1 }, { elapsedMinutes: 661 }, { elapsedMinutes: 1.5 }, { elapsedMinutes: '360' }]) {
      await request(SIM, '/simulation/event-day/position', 'PUT', invalid, 400);
      assert.equal((await runningStatus(anchor)).accessPoints[0].scenario, 'offline');
    }
    await start(); await reset(); await stable('reset during running', 'baseline', null);
    anchor = await start();
    const arrival = await wait('real ARRIVAL transition', async () => { const s = await runningStatus(anchor); assert.equal(s.phase, 'ARRIVAL'); return s; }, 155000);
    assert((performance.now() - anchor.after) / 1000 <= 155);
    await save('arrival', { anchor, elapsed: (performance.now() - anchor.after) / 1000, state: arrival });
    assertStatus(await put(360), 'held', 360);
    await stable('manual hold stops automatic progression', 'held', 360);
    await reset();
  }
  if (mode === 'restart') {
    const anchor = await start();
    await wait('run advances before process restart', async () => { assert((await runningStatus(anchor)).elapsedMinutes >= 2); });
    await request(SIM, '/simulation/access-points/ap-001', 'PUT', { scenario: 'offline' });
    const command = spawnSync('docker', ['compose', '--project-name', 'venue-network-operations-console', '--file', resolve('compose.yaml'), 'restart', 'telemetry-simulator'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(command.status, 0, command.stderr);
    const fresh = await wait('restarted simulator starts baseline', async () => assertStatus(await status(), 'baseline', null));
    assert(fresh.accessPoints.every(a => a.scenario === 'healthy'));
    await reset(); await stable('restarted process does not resume', 'baseline', null);
    await save('process-restart', { fresh, output: command.stdout + command.stderr });
  }
  if (mode === 'full') await fullRun();
} catch (error) { failure = error; }
finally {
  try {
    await reset(true);
    const first = await status(); await delay(1100); assert.deepEqual(await status(), first);
    await save('cleanup', { resetVerified: true, progressionStopped: true });
  } catch (error) { failure ??= error; await save('cleanup', { resetVerified: false, error: String(error) }); }
  if (socket?.readyState === WebSocket.OPEN) { try { await cdp('Browser.close', {}, true); } catch {} socket.close(); }
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([new Promise(r => chrome.once('exit', r)), delay(5000)]); }
  await chromeLog?.close();
}
log(`Evidence: ${evidence}`);
if (failure) { console.error(failure); process.exitCode = 1; }
else log(`PASS: ${mode} verification complete`);
NODE
