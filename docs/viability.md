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

- Venue API viability response: <http://127.0.0.1:8080/api/viability>
- Simulator metrics: <http://127.0.0.1:8081/metrics>
- Prometheus: <http://127.0.0.1:9090>
- Blackbox Exporter: <http://127.0.0.1:9115>

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
- Prometheus, Blackbox Exporter, and .NET base images use versioned tags. Compose assigns `latest` tags to locally built application images. `docker compose images --format json` supplies image inventory/local image information, not registry `RepoDigests`. Use `docker image inspect` on each running container's actual image ID to inspect its `RepoDigests`.
- Prometheus stores seven days of metrics in a named local volume. This is adequate for a local proof but is neither highly available nor replicated.
- `GET /health/live` is liveness only. It deliberately does not claim that Prometheus or downstream dependencies are ready.
- Alertmanager, PostgreSQL, SignalR, React, authentication, venue mapping, external probes, and vendor-controller integration remain outside this milestone.

## Milestone 4, Task 4 verification — September 11, 2026

The Milestone 1 results above remain historical evidence. This verification used repository baseline `399d21a49cf46a69a86baf98c333f51c1242dec7` (`fix: represent sparse history coverage accurately`) with the four publication changes described below. The environment was Docker Desktop **4.88.1 (237512)**, Docker Engine **29.7.2**, and Docker Compose **5.4.0**, using the `desktop-linux` context.

### IPv4 host publications

Compose publishes ports 8080, 8081, 9090, and 9115 only on the Docker host's IPv4 loopback address, `127.0.0.1`. These host publications are not bound to network-facing IPv4 or IPv6 addresses. IPv6 loopback (`::1`) is not published. Venue containers continue communicating through the Compose network.

| Service | Host publication | Container port |
|---|---|---|
| Venue API | `127.0.0.1:8080` | `8080/tcp` |
| Telemetry simulator | `127.0.0.1:8081` | `8080/tcp` |
| Prometheus | `127.0.0.1:9090` | `9090/tcp` |
| Blackbox Exporter | `127.0.0.1:9115` | `9115/tcp` |

Resolved Compose configuration contained exactly these four publications. Both `HostConfig.PortBindings` and `NetworkSettings.Ports` contained only `127.0.0.1`, and host listener inspection showed four IPv4 listeners on those addresses. The remaining resolved configuration was unchanged from baseline.

### Verified image evidence

The existing images were reused without building or pulling. All four running images were inspected as `linux/arm64`; their full local image IDs, tags, platforms, and available `RepoDigests` remained unchanged after container recreation and verification.

| Service | Configured registry tag or generated local build tag | Platform | Registry evidence |
|---|---|---|---|
| Prometheus | `prom/prometheus:v3.13.3` | `linux/arm64` | `RepoDigest` recorded below |
| Blackbox Exporter | `quay.io/prometheus/blackbox-exporter:v0.28.0` | `linux/arm64` | `RepoDigest` recorded below |
| Venue API | `venue-network-operations-console-venue-api:latest` | `linux/arm64` | Local build; `RepoDigests: []` |
| Telemetry simulator | `venue-network-operations-console-telemetry-simulator:latest` | `linux/arm64` | Local build; `RepoDigests: []` |

Available registry references from `docker image inspect` on the images actually used by the containers:

```text
prom/prometheus@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7
quay.io/prometheus/blackbox-exporter@sha256:e753ff9f3fc458d02cca5eddab5a77e1c175eee484a8925ac7d524f04366c2fc
```

These are observed `RepoDigests`; they were not independently established as architecture-specific manifest digests. The local application builds have no registry digest in the inspected metadata. Comparing their local image IDs establishes reuse during this verification, not reproducibility of a future build.

Both application Dockerfiles configure these base tags:

- SDK: `mcr.microsoft.com/dotnet/sdk:10.0.401-alpine3.23`
- Runtime: `mcr.microsoft.com/dotnet/aspnet:10.0.12-alpine3.23`

Original-build base-image digests were not established. The base tags were not separately available as inspectable local images, so their platforms were not independently verified. No base images were pulled to fill that evidence gap. Compose and Dockerfiles still use their existing tags; this evidence does not make the configuration digest-pinned.

### Access, regression, and data preservation

- Explicit `127.0.0.1` requests passed for API health, operations overview and AP history; simulator health and metrics; Prometheus readiness and query; and Blackbox metrics. Prometheus collection and the Blackbox probe remained healthy.
- All existing assertions in `tests/viability/verify.sh`, `tests/milestone2/verify.sh`, and `tests/milestone3/verify.sh` passed sequentially. Their existing `localhost` consumers worked with IPv4-only publication. Each gate restored healthy AP state and cleared the AP-down alert. Frontend lint and production build passed through the latter two gates.
- This run reused images by adapting only script invocations outside the repository: known Compose startup used `--no-build --pull never`, one-off promtool runs used `--pull never`, and npm ran through Corepack npm `11.19.1`. Docker invocations were explicitly scoped to this Compose project. Assertions and cleanup were unchanged; the temporary wrappers were removed.
- A temporary Vite server using Node `22.23.2` and Corepack npm `11.19.1`, bound to `127.0.0.1`, served the page and transformed `App.tsx`. Overview and history requests passed through the unchanged `/api` proxy target, `http://localhost:8080`. The temporary server was stopped afterward.
- The named volume `venue-network-operations-console_prometheus-data`, created `2026-08-27T01:51:32Z`, retained the same identity, metadata, and mount at `/prometheus`. Its Docker volume mountpoint remained `/var/lib/docker/volumes/venue-network-operations-console_prometheus-data/_data`, and retention remained `7d`.
- A fixed Prometheus range query for `venue_ap_operational{ap_id="ap-001"}`, with `start=1789132085`, `end=1789132385`, and `step=5s`, returned the same labels, timestamps, and values for all **61 points** before and after recreation. The range ended before the binding change; newly collected samples were not substituted.
- The existing `venue-network-operations-console_default` network and service relationships were preserved. Only the four Venue containers were recreated; all were running afterward, with every configured healthcheck healthy.
