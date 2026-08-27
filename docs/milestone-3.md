# Milestone 3: Access Point History

Milestone 3 adds one bounded historical path without introducing a database or a charting dependency:

```text
Prometheus /api/v1/query_range -> Venue API history DTO -> React history panel
```

The implementation proves timestamped AP history, explicit gaps during unavailable observations, safe query parameters, and an operator-facing view. Prometheus remains the metric history store.

## Viability evidence

Before implementation, a real one-minute query for `ap-001` produced 13 operational samples containing both `1` and `0`. During the same outage interval, channel utilization returned only 10 samples and never returned a false zero. That verified that unavailable RF telemetry appears as a gap in Prometheus history.

The completed API then returned a 15-minute response with 181 aligned samples. Five recorded outage samples had `operational: false`, `clients: 0`, and `null` RF, latency, and packet-loss observations. The first and final samples were healthy after recovery.

## API contract

`GET /api/operations/access-points/{apId}/history?window=15m`

Supported windows are deliberately fixed:

| Window | Query step | Maximum aligned points |
|---|---:|---:|
| `15m` | 5 seconds | 181 |
| `1h` | 15 seconds | 241 |
| `6h` | 60 seconds | 361 |
| `24h` | 300 seconds | 289 |

The response contains:

- AP ID and zone
- Normalized window, start/end timestamps, and resolution step
- Simulated source classification
- Timestamped samples containing operational state, clients, channel utilization, management latency, and management packet loss

The API joins metric families by timestamp. Operational state supplies the required timeline. Client samples are required at every timestamp. RF, latency, and packet-loss values are required only when the AP is operational; they become `null` when the operational sample is offline.

An unsupported window returns HTTP 400, an unknown AP returns HTTP 404, and malformed or incomplete Prometheus history returns HTTP 503 Problem Details. Callers cannot submit metric names, raw durations, or arbitrary PromQL.

## Run and verify

Install the locked frontend dependencies once:

```bash
cd src/VenueOps.Web
npm ci
```

Then run the complete gate from the repository root:

```bash
./tests/milestone3/verify.sh
```

The gate checks the frontend, starts the Compose stack, validates the healthy history contract, checks 400/404 behavior, records an AP outage, verifies unavailable observations, restores the AP, and proves that both states remain in the returned history.

For interactive development, keep the Compose stack running and start Vite:

```bash
cd src/VenueOps.Web
npm run dev
```

Open <http://localhost:5173>. The history panel supports AP and time-window selection, summarizes samples and state changes, displays an outage timeline, and lists the twelve most recent samples.

## Important implementation concepts

### Matrix result

An instant Prometheus query returns a vector containing one value per series at one evaluation time. A range query returns a matrix containing multiple timestamp/value pairs per labeled series. The API parses these as different result types rather than assuming one JSON shape.

### Query step

The step is the interval at which Prometheus evaluates the expression over the requested range. Longer windows use larger steps to keep response and rendering size bounded. These are evaluated points at the chosen resolution, not an export of every raw TSDB sample.

### Timestamp alignment

Metric arrays are not joined by array position. The API validates labels and joins operational, client, RF, latency, and loss points by their timestamps. Missing required timestamps fail explicitly.

### Historical gaps

When an AP is offline, Prometheus retains the operational `0` series while unavailable RF series have gaps. The application maps those gaps to nullable fields only for offline samples and never manufactures numeric zeros.

## Access, cost, and reliability

- The feature uses the existing local Prometheus API and adds no account, key, paid service, rate limit, or frontend package.
- Available history is limited by Prometheus retention and how long the local stack has actually been collecting. Selecting `24h` does not fabricate data if the stack has run for less than 24 hours.
- Prometheus storage remains local, single-node, and non-replicated, which is acceptable for this portfolio milestone.

## Still deferred

- Full metric charts and charting libraries
- Zone-level historical comparisons
- Incident annotations and persisted event metadata
- Custom date ranges or user-supplied PromQL
- Floor-plan and topology history
- PostgreSQL, SignalR, Alertmanager, authentication, and deployment
