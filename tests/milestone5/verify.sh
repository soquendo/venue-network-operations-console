#!/usr/bin/env bash
set -euo pipefail

# Uses the already-running Venue stack. It never builds images or modifies storage.
python3 - "$@" <<'PY'
import argparse
import datetime
import json
import math
import pathlib
import re
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description="Verify held event positions through the running Venue telemetry pipeline.")
parser.add_argument("--evidence-dir", type=pathlib.Path)
parser.add_argument("--fail-after-peak", action="store_true", help="Deliberately fail after mutation to exercise reset cleanup.")
args = parser.parse_args()
evidence = args.evidence_dir or pathlib.Path(tempfile.mkdtemp(prefix="venueops-m5-"))
evidence.mkdir(parents=True, exist_ok=True)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SIM = "http://127.0.0.1:8081"
API = "http://127.0.0.1:8080"
PROM = "http://127.0.0.1:9090"
AP_IDS = ["ap-001", "ap-002", "ap-003", "ap-004"]
FIELDS = ["clients", "channelUtilizationRatio", "managementLatencySeconds", "managementPacketLossRatio"]
METRICS = ["venue_ap_clients", "venue_ap_channel_utilization_ratio", "venue_ap_management_latency_seconds", "venue_ap_management_packet_loss_ratio"]
BASELINE = [[42, 35, 28, 31], [.55, .48, .41, .46], [.018, .016, .015, .017], [.002, .001, .001, .002]]
BUILDING = [[63, 53, 35, 39], [.75, .68, .51, .56], [.038, .022, .015, .017], [.002, .001, .001, .002]]
PEAK = [[84, 70, 42, 47], [.95, .88, .61, .66], [.078, .062, .015, .019], [.017, .009, .001, .002]]

def request(base, path, method="GET", body=None, expected_status=200):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        response = opener.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        text = response.read().decode()
        assert response.code == expected_status, (method, path, response.code, text)
        try:
            return json.loads(text)
        except ValueError:
            return text

def save(name, body):
    (evidence / (name + ".json")).write_text(json.dumps(body, indent=2) + "\n")

def wait_for(description, check, timeout=30):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            print("PASS:", description, flush=True)
            return result
        except (AssertionError, urllib.error.URLError, TimeoutError, KeyError) as error:
            last_error = error
        time.sleep(1)
    raise AssertionError(f"{description}: timed out; last observation: {last_error}")

def equal(actual, expected):
    assert actual is not None and math.isclose(float(actual), expected, rel_tol=0, abs_tol=1e-12), (actual, expected)

def assert_aps(aps, expected, classified=False):
    assert [ap["apId"] for ap in aps] == AP_IDS
    for index, ap in enumerate(aps):
        assert ap["zone"] == ("zone-a" if index < 2 else "zone-b")
        assert ap["operational"] is True
        for field, values in zip(FIELDS, expected):
            equal(ap[field], values[index])
        if classified:
            assert ap["degraded"] is (expected is PEAK and index < 2)
            assert ap["alertState"] == "inactive"

def status(expected, minute, phase, load):
    body = request(SIM, "/simulation/event-day")
    assert body["scenario"] == "High-Density Event Day"
    assert body["mode"] == ("baseline" if minute is None else "held")
    assert body["elapsedMinutes"] == minute and body["phase"] == phase
    equal(body["normalizedLoad"], load)
    assert_aps(body["accessPoints"], expected)
    return body

def raw_metrics(expected, path="/metrics"):
    text = request(SIM, path)
    samples = {}
    for line in text.splitlines():
        match = re.fullmatch(r'(venue_ap_\w+)\{([^}]+)\} (\S+)', line)
        if match:
            labels = dict(re.findall(r'(\w+)="([^"]*)"', match[2]))
            samples[(match[1], labels["ap_id"], labels["zone"])] = float(match[3])
    assert len(samples) == 20
    assert {key[0] for key in samples} == set(METRICS + ["venue_ap_operational"])
    for index, ap in enumerate(AP_IDS):
        zone = "zone-a" if index < 2 else "zone-b"
        equal(samples[("venue_ap_operational", ap, zone)], 1)
        for metric, values in zip(METRICS, expected):
            equal(samples[(metric, ap, zone)], values[index])
    return text

def prometheus(expected):
    expression = '{__name__=~"venue_ap_.*|zone:venue_ap_.*"}'
    body = request(PROM, "/api/v1/query?" + urllib.parse.urlencode({"query": expression}))
    assert body["status"] == "success"
    samples = {(row["metric"]["__name__"], row["metric"].get("ap_id"), row["metric"]["zone"]): float(row["value"][1]) for row in body["data"]["result"]}
    for index, ap in enumerate(AP_IDS):
        zone = "zone-a" if index < 2 else "zone-b"
        equal(samples[("venue_ap_operational", ap, zone)], 1)
        for metric, values in zip(METRICS, expected):
            equal(samples[(metric, ap, zone)], values[index])
    for zone, indices in [("zone-a", (0, 1)), ("zone-b", (2, 3))]:
        equal(samples[("zone:venue_ap_operational:avg", None, zone)], 1)
        equal(samples[("zone:venue_ap_clients:sum", None, zone)], sum(expected[0][i] for i in indices))
    return body

def overview(expected, warning=None):
    body = request(API, "/api/operations/overview")
    assert_aps(body["accessPoints"], expected, classified=True)
    assert body["simulatorScrape"]["up"] is True
    assert body["probe"]["success"] is True and body["probe"]["httpStatusCode"] == 200
    assert [zone["zone"] for zone in body["zones"]] == ["zone-a", "zone-b"]
    assert [zone["clients"] for zone in body["zones"]] == [sum(expected[0][:2]), sum(expected[0][2:])]
    assert [zone["operationalRatio"] for zone in body["zones"]] == [1, 1]
    assert [zone["degradedAccessPoints"] for zone in body["zones"]] == ([2, 0] if expected is PEAK else [0, 0])
    if warning:
        assert [ap["degradationAlertState"] for ap in body["accessPoints"]] == ([warning, warning, "inactive", "inactive"] if expected is PEAK else ["inactive"] * 4)
    return body

def alert_rule(state):
    body = request(PROM, "/api/v1/rules")
    rules = {rule["name"]: rule for group in body["data"]["groups"] for rule in group["rules"]}
    rule = rules["VenueApDegraded"]
    assert rule["health"] == "ok" and rule["duration"] == 30
    assert rule["labels"] == {"severity": "warning", "telemetry_source": "simulated"}
    assert rules["VenueApDown"]["duration"] == 10
    assert rules["VenueApDown"]["state"] == "inactive"
    assert rule["state"] == state
    alerts = rule["alerts"]
    assert sorted(alert["labels"]["ap_id"] for alert in alerts) == ([] if state == "inactive" else AP_IDS[:2])
    for alert in alerts:
        assert alert["state"] == state and alert["labels"]["zone"] == "zone-a"
    return rule

def instant(timestamp):
    return datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()

def history(expected, since, degraded):
    body = request(API, "/api/operations/access-points/ap-001/history?window=15m")
    assert body["apId"] == "ap-001" and body["window"] == "15m" and body["stepSeconds"] == 5
    samples = body["samples"]
    timestamps = [instant(sample["observedAtUtc"]) for sample in samples]
    assert timestamps == sorted(set(timestamps))
    found = [sample for sample in samples if instant(sample["observedAtUtc"]) >= since and sample["clients"] == expected[0][0] and sample["degraded"] is degraded]
    assert found, "No newly collected matching history sample"
    for sample in found:
        assert sample["operational"] is True
        for field, values in zip(FIELDS, expected):
            equal(sample[field], values[0])
    return body

def verify_stage(name, expected, minute, phase, load, warning=None):
    save(name + "-status", status(expected, minute, phase, load))
    (evidence / (name + "-metrics-alias.txt")).write_text(raw_metrics(expected, "/METRICS/"))
    (evidence / (name + "-metrics.txt")).write_text(raw_metrics(expected))
    save(name + "-prometheus", wait_for(name + " Prometheus values", lambda: prometheus(expected)))
    save(name + "-overview", wait_for(name + " API values and quality", lambda: overview(expected, warning)))

def reset_and_verify():
    request(SIM, "/simulation/event-day/reset", "POST")
    status(BASELINE, None, None, 0)
    raw_metrics(BASELINE)
    wait_for("cleanup baseline collected by Prometheus", lambda: prometheus(BASELINE))
    wait_for("cleanup baseline API and inactive warnings", lambda: overview(BASELINE, "inactive"))
    wait_for("cleanup all alerts inactive", lambda: alert_rule("inactive"))

def interrupted(signum, frame):
    raise RuntimeError(f"Verification interrupted by signal {signum}")

# Register cleanup before the first hosted mutation; report cleanup errors as failures.
signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
failure = None
try:
    reset_and_verify()
    baseline = request(SIM, "/simulation/event-day")
    for invalid in [{}, {"elapsedMinutes": None}, {"elapsedMinutes": -1}, {"elapsedMinutes": 661}, {"elapsedMinutes": 1.5}, {"elapsedMinutes": "360"}, {"elapsedMinutes": 2147483648}]:
        request(SIM, "/simulation/event-day/position", "PUT", invalid, 400)
        assert request(SIM, "/simulation/event-day") == baseline
    request(SIM, "/simulation/access-points/ap-999", "PUT", {"scenario": "healthy"}, 404)
    request(SIM, "/simulation/access-points/ap-001", "PUT", {"scenario": "unsupported"}, 400)
    request(SIM, "/simulation/event-day/start", "POST", expected_status=404)
    print("PASS: invalid controls are non-mutating; automatic start is absent", flush=True)

    first = request(SIM, "/simulation/event-day/position", "PUT", {"elapsedMinutes": 0})
    assert request(SIM, "/simulation/event-day/position", "PUT", {"elapsedMinutes": 0}) == first
    verify_stage("baseline", BASELINE, 0, "PRE_OPEN", 0, "inactive")

    peak_started = time.time()
    request(SIM, "/simulation/event-day/position", "PUT", {"elapsedMinutes": 360})
    if args.fail_after_peak:
        raise RuntimeError("Intentional failure after peak to verify cleanup")
    verify_stage("peak", PEAK, 360, "PEAK_DENSITY", 1)
    pending = wait_for("peak warning first observed pending", lambda: alert_rule("pending"))
    save("peak-pending", pending)
    firing = wait_for("sustained peak warning firing", lambda: alert_rule("firing"), timeout=60)
    assert time.time() - peak_started >= 30
    assert {a["labels"]["ap_id"]: a["activeAt"] for a in pending["alerts"]} == {a["labels"]["ap_id"]: a["activeAt"] for a in firing["alerts"]}
    save("peak-firing", firing)
    save("peak-overview-firing", wait_for("API exposes separate firing warnings", lambda: overview(PEAK, "firing")))
    save("peak-history", wait_for("newly collected peak appears in history", lambda: history(PEAK, peak_started, True)))

    recovery_started = time.time()
    request(SIM, "/simulation/event-day/position", "PUT", {"elapsedMinutes": 570})
    verify_stage("recovery", BUILDING, 570, "RECOVERY", .5, "inactive")
    save("recovery-alert", wait_for("recovery clears warnings", lambda: alert_rule("inactive")))
    save("recovery-history", wait_for("newly collected recovery appears in history", lambda: history(BUILDING, recovery_started, False)))

    reset_started = time.time()
    request(SIM, "/simulation/event-day/reset", "POST")
    verify_stage("reset", BASELINE, None, None, 0, "inactive")
    final_history = wait_for("reset baseline appears in retained history", lambda: history(BASELINE, reset_started, False))
    assert any(instant(s["observedAtUtc"]) >= peak_started and s["degraded"] and s["clients"] == 84 for s in final_history["samples"])
    assert any(instant(s["observedAtUtc"]) >= recovery_started and not s["degraded"] and s["clients"] == 63 for s in final_history["samples"])
    save("reset-history", final_history)
    save("timing", {"peakRequestedAt": peak_started, "recoveryRequestedAt": recovery_started, "resetRequestedAt": reset_started})
except BaseException as error:
    failure = error
finally:
    try:
        reset_and_verify()
        save("cleanup", {"resetVerified": True})
    except BaseException as cleanup_error:
        print("FAIL: reset cleanup:", cleanup_error, file=sys.stderr)
        save("cleanup", {"resetVerified": False, "error": str(cleanup_error)})
        failure = failure or cleanup_error

print("Evidence:", evidence, flush=True)
if failure:
    print("FAIL:", failure, file=sys.stderr)
    sys.exit(1)
print("All held-position API/Prometheus/history checks passed.", flush=True)
PY
