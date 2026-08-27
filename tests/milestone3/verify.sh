#!/usr/bin/env bash
set -euo pipefail

readonly API_URL="http://localhost:8080"
readonly SIMULATOR_URL="http://localhost:8081"
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

wait_for_history() {
  local jq_expression="$1"
  local description="$2"
  local deadline=$((SECONDS + STATE_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    local body
    if body="$(curl --fail --silent --show-error \
      "${API_URL}/api/operations/access-points/ap-001/history?window=15m" 2>/dev/null)" \
      && jq --exit-status "$jq_expression" >/dev/null <<<"$body"; then
      printf 'PASS: %s\n' "$description"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  printf 'FAIL: %s\n' "$description" >&2
  curl --silent --show-error \
    "${API_URL}/api/operations/access-points/ap-001/history?window=15m" | jq . >&2 || true
  return 1
}

require_command curl
require_command docker
require_command jq
require_command npm

printf 'Checking the React/TypeScript client...\n'
npm --prefix src/VenueOps.Web run lint
npm --prefix src/VenueOps.Web run build

printf 'Starting the monitoring stack...\n'
docker compose up --build --detach --wait

wait_for_history \
  '.apId == "ap-001" and .zone == "zone-a" and .window == "15m" and .stepSeconds == 5 and .source == "simulated" and (.samples | length) > 0 and (.samples[-1].operational == true) and all(.samples[]; if .operational then (.channelUtilizationRatio | type) == "number" and (.managementLatencySeconds | type) == "number" and (.managementPacketLossRatio | type) == "number" else .channelUtilizationRatio == null and .managementLatencySeconds == null and .managementPacketLossRatio == null end)' \
  'history returns bounded, aligned samples with honest observation availability'

unsupported_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "${API_URL}/api/operations/access-points/ap-001/history?window=7d")"
if [[ "$unsupported_status" != "400" ]]; then
  printf 'FAIL: unsupported history window returned HTTP %s instead of 400\n' \
    "$unsupported_status" >&2
  exit 1
fi
printf 'PASS: unsupported history window returns HTTP 400\n'

unknown_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "${API_URL}/api/operations/access-points/ap-999/history?window=15m")"
if [[ "$unknown_status" != "404" ]]; then
  printf 'FAIL: unknown AP returned HTTP %s instead of 404\n' "$unknown_status" >&2
  exit 1
fi
printf 'PASS: unknown AP returns HTTP 404\n'

printf 'Taking ap-001 offline...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"scenario":"offline"}' \
  "${SIMULATOR_URL}/simulation/access-points/ap-001" | jq .

wait_for_history \
  '.samples[-1].operational == false and .samples[-1].clients == 0 and .samples[-1].channelUtilizationRatio == null and .samples[-1].managementLatencySeconds == null and .samples[-1].managementPacketLossRatio == null' \
  'latest history sample represents the AP outage with null unavailable observations'

printf 'Restoring ap-001...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"scenario":"healthy"}' \
  "${SIMULATOR_URL}/simulation/access-points/ap-001" | jq .

wait_for_history \
  '.samples[-1].operational == true and .samples[-1].channelUtilizationRatio != null and ([.samples[].operational] | any(. == false)) and ([.samples[].operational] | any(. == true))' \
  'recovery returns current measurements while retaining both states in history'

printf '\nAll Milestone 3 history checks passed.\n'
