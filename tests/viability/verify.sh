#!/usr/bin/env bash
set -euo pipefail

readonly API_URL="http://localhost:8080"
readonly SIMULATOR_URL="http://localhost:8081"
readonly PROMETHEUS_URL="http://localhost:9090"
readonly POLL_INTERVAL_SECONDS=2
readonly STATE_TIMEOUT_SECONDS=30

cleanup() {
  curl --fail --silent --show-error \
    --request PUT \
    --header 'Content-Type: application/json' \
    --data '{"scenario":"healthy"}' \
    "${SIMULATOR_URL}/simulation/access-points/ap-001" >/dev/null 2>&1 || true
}

trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + STATE_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  printf 'Timed out waiting for %s\n' "$url" >&2
  return 1
}

wait_for_viability() {
  local jq_expression="$1"
  local description="$2"
  local deadline=$((SECONDS + STATE_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    local body
    if body="$(curl --fail --silent --show-error "${API_URL}/api/viability" 2>/dev/null)" \
      && jq --exit-status "$jq_expression" >/dev/null <<<"$body"; then
      printf 'PASS: %s\n' "$description"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  printf 'FAIL: %s\n' "$description" >&2
  curl --silent --show-error "${API_URL}/api/viability" | jq . >&2 || true
  return 1
}

prometheus_query() {
  curl --get --fail --silent --show-error \
    --data-urlencode "query=$1" \
    "${PROMETHEUS_URL}/api/v1/query"
}

require_command curl
require_command docker
require_command jq

printf 'Validating Prometheus configuration and alert rules...\n'
docker compose run --rm --no-deps --entrypoint promtool prometheus \
  check config /etc/prometheus/prometheus.yml
docker compose run --rm --no-deps --entrypoint promtool prometheus \
  check rules /etc/prometheus/rules/venue.rules.yml

printf 'Starting the viability stack...\n'
docker compose up --build --detach --wait

wait_for_http "${SIMULATOR_URL}/health/live"
wait_for_http "${PROMETHEUS_URL}/-/ready"
wait_for_http "${API_URL}/health/live"

printf 'Checking the raw simulator metric contract...\n'
raw_metrics="$(curl --fail --silent --show-error "${SIMULATOR_URL}/metrics")"
operational_series_count="$(grep -c '^venue_ap_operational{' <<<"$raw_metrics")"
if [[ "$operational_series_count" -ne 4 ]]; then
  printf 'FAIL: expected 4 venue_ap_operational series, found %s\n' "$operational_series_count" >&2
  exit 1
fi
printf 'PASS: simulator exposes four AP operational series\n'

for required_metric in \
  venue_ap_clients \
  venue_ap_channel_utilization_ratio \
  venue_ap_management_latency_seconds \
  venue_ap_management_packet_loss_ratio; do
  if ! grep -q "^${required_metric}{" <<<"$raw_metrics"; then
    printf 'FAIL: raw metrics omitted %s\n' "$required_metric" >&2
    exit 1
  fi
done
printf 'PASS: simulator exposes every required metric family\n'

wait_for_viability \
  '.ap.apId == "ap-001" and .ap.operational == true and .ap.source == "simulated" and .zone.zone == "zone-a" and .zone.operationalRatio == 1 and .zone.source == "derived" and .probe.success == true and .probe.httpStatusCode == 200 and (.probe.durationSeconds >= 0) and .probe.source == "measured" and .simulatorScrape.up == true and .alert.state == "inactive"' \
  'healthy API response includes simulated, measured, and derived telemetry'

initial_query="$(prometheus_query 'venue_ap_operational')"
if [[ "$(jq '[.data.result[] | select(.value[1] == "1")] | length' <<<"$initial_query")" -ne 4 ]]; then
  printf 'FAIL: Prometheus did not return four healthy APs\n' >&2
  exit 1
fi
printf 'PASS: Prometheus collected four healthy APs\n'

zone_clients="$(prometheus_query 'zone:venue_ap_clients:sum')"
if ! jq --exit-status \
  '([.data.result[] | select(.metric.zone == "zone-a") | .value[1]] == ["77"]) and ([.data.result[] | select(.metric.zone == "zone-b") | .value[1]] == ["59"])' \
  >/dev/null <<<"$zone_clients"; then
  printf 'FAIL: zone client totals did not match the deterministic sample\n' >&2
  exit 1
fi
printf 'PASS: zone client recording rule returns 77 and 59 clients\n'

range_start="$(( $(date -u +%s) - 10 ))"

printf 'Taking ap-001 offline...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"scenario":"offline"}' \
  "${SIMULATOR_URL}/simulation/access-points/ap-001" | jq .

wait_for_viability \
  '.ap.operational == false and .ap.value == 0 and .zone.operationalRatio == 0.5 and .alert.state == "firing" and .simulatorScrape.up == true and .probe.success == true' \
  'AP failure is detected while the simulator and real probe remain reachable'

range_end="$(date -u +%s)"
history="$(curl --get --fail --silent --show-error \
  --data-urlencode 'query=venue_ap_operational{ap_id="ap-001"}' \
  --data-urlencode "start=${range_start}" \
  --data-urlencode "end=${range_end}" \
  --data-urlencode 'step=5s' \
  "${PROMETHEUS_URL}/api/v1/query_range")"

if ! jq --exit-status \
  '([.data.result[0].values[][1]] | any(. == "1")) and ([.data.result[0].values[][1]] | any(. == "0"))' \
  >/dev/null <<<"$history"; then
  printf 'FAIL: range query did not contain both healthy and offline samples\n' >&2
  exit 1
fi
printf 'PASS: Prometheus history contains the healthy-to-offline transition\n'

printf 'Restoring ap-001...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"scenario":"healthy"}' \
  "${SIMULATOR_URL}/simulation/access-points/ap-001" | jq .

wait_for_viability \
  '.ap.operational == true and .zone.operationalRatio == 1 and .alert.state == "inactive"' \
  'AP recovery clears the alert and restores the zone ratio'

printf '\nAll Milestone 1 viability checks passed.\n'
