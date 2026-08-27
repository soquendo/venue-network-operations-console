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

wait_for_overview() {
  local jq_expression="$1"
  local description="$2"
  local deadline=$((SECONDS + STATE_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    local body
    if body="$(curl --fail --silent --show-error "${API_URL}/api/operations/overview" 2>/dev/null)" \
      && jq --exit-status "$jq_expression" >/dev/null <<<"$body"; then
      printf 'PASS: %s\n' "$description"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  printf 'FAIL: %s\n' "$description" >&2
  curl --silent --show-error "${API_URL}/api/operations/overview" | jq . >&2 || true
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

wait_for_overview \
  '(.accessPoints | length) == 4 and (.zones | length) == 2 and ([.accessPoints[] | select(.operational == true)] | length) == 4 and ([.accessPoints[] | select(.channelUtilizationRatio == null or .managementLatencySeconds == null or .managementPacketLossRatio == null)] | length) == 0 and ([.zones[] | select(.operationalRatio == 1)] | length) == 2 and .probe.success == true and .probe.httpStatusCode == 200 and .simulatorScrape.up == true' \
  'overview maps four healthy APs, two healthy zones, and measured path health'

printf 'Taking ap-001 offline...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"scenario":"offline"}' \
  "${SIMULATOR_URL}/simulation/access-points/ap-001" | jq .

wait_for_overview \
  '(.accessPoints[] | select(.apId == "ap-001") | .operational == false and .clients == 0 and .channelUtilizationRatio == null and .managementLatencySeconds == null and .managementPacketLossRatio == null and .alertState == "firing") and (.zones[] | select(.zone == "zone-a") | .operationalRatio == 0.5 and .clients == 35) and .probe.success == true and .simulatorScrape.up == true' \
  'overview preserves the offline AP, marks unavailable observations null, and maps the firing alert'

printf 'Restoring ap-001...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"scenario":"healthy"}' \
  "${SIMULATOR_URL}/simulation/access-points/ap-001" | jq .

wait_for_overview \
  '(.accessPoints[] | select(.apId == "ap-001") | .operational == true and .alertState == "inactive") and (.zones[] | select(.zone == "zone-a") | .operationalRatio == 1 and .clients == 77)' \
  'overview returns to the healthy baseline after AP recovery'

printf '\nAll Milestone 2 operations-overview checks passed.\n'
