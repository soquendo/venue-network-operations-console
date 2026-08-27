# Milestone 1: Telemetry Pipeline Viability

This milestone proves a monitoring path before any user interface is created:

```text
Telemetry simulator --/metrics--> Prometheus --PromQL/HTTP--> Venue API --JSON--> caller
                                         ^
                                         |
Venue API /health/live <--HTTP probe-- Blackbox Exporter
```

The four APs and their wireless statistics are fictional. The Prometheus scrapes, HTTP requests, Blackbox probe, alert evaluation, and stored samples are real local operations.

## Run the proof

Prerequisites:

- Docker with Compose support
- `curl`
- `jq`

From the repository root:

```bash
./tests/viability/verify.sh
```

The script validates Prometheus configuration, starts the stack, proves the healthy baseline, takes `ap-001` offline, waits for `VenueApDown` to fire, verifies history, restores the AP, and waits for the alert to clear. It restores `ap-001` if the script exits early.

Useful local endpoints after the stack is running:

- Venue API viability response: <http://localhost:8080/api/viability>
- Simulator metrics: <http://localhost:8081/metrics>
- Prometheus: <http://localhost:9090>
- Blackbox Exporter: <http://localhost:9115>

Stop the stack without deleting metric history:

```bash
docker compose down
```

Delete the stack and its local Prometheus history only when a clean reset is intended:

```bash
docker compose down --volumes
```

## Verified result

Milestone 1 passed the complete automated viability gate locally on August 26, 2026. The verification run established that:

- `promtool` accepted the Prometheus configuration and all three rules.
- The simulator exposed four AP operational series and every required metric family.
- Prometheus collected four initially healthy APs and calculated the expected zone client totals: 77 for `zone-a` and 59 for `zone-b`.
- The Venue API returned simulated AP state, a derived zone ratio, a measured HTTP probe, the simulator scrape result, and the derived alert state.
- Taking `ap-001` offline changed its operational value to `0`, reduced the `zone-a` operational ratio to `0.5`, and caused `VenueApDown` to fire while the simulator scrape and Blackbox probe remained healthy.
- A Prometheus range query contained both healthy and offline samples for `ap-001`, proving timestamped historical collection.
- Restoring `ap-001` returned the zone ratio to `1` and cleared the alert.

The verification is repeatable with `./tests/viability/verify.sh`; any missing series, incorrect mapping, non-finite value, or timeout fails the script.

## What each component proves

### Telemetry exporter

**What this is:** An HTTP endpoint that publishes the current metric snapshot in Prometheus exposition format.

**Why we're using it:** It represents the boundary where a future wireless-controller integration would translate controller data into stable, vendor-neutral metrics.

The .NET library's broad default runtime collectors are suppressed for this milestone. The hosts still publish the intentional venue metrics and ASP.NET request measurements, keeping the first proof small and auditable.

### Prometheus

**What this is:** A monitoring system that periodically pulls labeled samples, stores them as time series, supports PromQL queries, and evaluates rules.

**Why we're using it:** It owns collection, metric history, zone aggregation, and AP-down alert evaluation instead of duplicating those capabilities in application code.

### Blackbox Exporter

**What this is:** An external prober that checks a target using protocols such as HTTP, DNS, TCP, or ICMP.

**Why we're using it:** Its HTTP module generates a genuine network measurement from the Blackbox container to the Venue API.

### Venue API

**What this is:** A purpose-built ASP.NET boundary that asks Prometheus fixed questions and returns a small domain response.

**Why we're using it:** A later React client should consume venue concepts rather than Prometheus's generic wire format or unrestricted PromQL.

The API reads Prometheus rather than simulator memory, so every reported state has passed through the collection pipeline. Missing required data returns HTTP 503 instead of being treated as healthy.

## Metric provenance

| Provenance | Examples | Meaning |
|---|---|---|
| Simulated | `venue_ap_operational`, clients, RF utilization, management latency/loss | Deterministic fictional controller telemetry |
| Measured | `up`, `scrape_duration_seconds`, `probe_success`, probe timing/status | Real results produced by Prometheus and Blackbox Exporter |
| Derived | Zone recording rules and `ALERTS` | PromQL calculations evaluated by Prometheus |

When an AP is offline, the simulator retains its explicit operational status and zero clients but removes RF and latency series it can no longer observe. Missing data is not silently rewritten as zero.

## Reliability and boundaries

- The Compose network has no external probe target, credentials, or service rate limits.
- Images and packages use explicit versions rather than floating `latest` tags. Capture the resolved image digests with `docker compose images --format json` when images are first pulled and record them with the viability evidence.
- Prometheus stores seven days of metrics in a named local volume. This is adequate for a local proof but is neither highly available nor replicated.
- `GET /health/live` is liveness only. It deliberately does not claim that Prometheus or downstream dependencies are ready.
- Alertmanager, PostgreSQL, SignalR, React, authentication, venue mapping, external probes, and vendor-controller integration remain outside this milestone.
