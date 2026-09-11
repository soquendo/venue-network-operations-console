# Milestone 4: Integrated Verification

Milestone 4 hardens the existing telemetry and history paths. Its closeout verifies their behavior together through the running API, monitoring stack, and rendered frontend. AP/controller telemetry remains fictional and simulated; HTTP requests, collection, alert evaluation, and browser behavior are real local operations.

## Correctness improvements

- Prometheus responses are validated at the typed-client boundary, including malformed JSON, invalid timestamps, null result entries, and duplicate operational-history timestamps.
- Overview and history requests have independent ownership and cancellation. Busy polling ticks are skipped; obsolete work cannot replace current state. Same-selection refresh failures retain successful data with an explicit error, while selection changes isolate history immediately.
- History cells use timestamp-proportional positions and query-resolution widths. Missing positions remain unobserved, state changes compare adjacent observations, and offline, zero, and unavailable measurements remain distinct.
- The four Compose host publications use IPv4 loopback. The [Task 4 evidence](viability.md#milestone-4-task-4-verification--september-11-2026) records image references, available registry digests, and their limitations.

## Verified environment and regression gates

Verification date: **September 11, 2026**. Repository baseline: `15251504cec316131804d7dadfdd018b09f9e4ab` (`chore: restrict container ports to IPv4 loopback`).

- Node 22.23.2; project npm 11.19.1 through Corepack; ordinary host npm 10.9.8.
- Host .NET SDK 10.0.400; configured container SDK 10.0.401; running application-container runtime 10.0.12; Microsoft.NET.Test.Sdk 17.14.1.
- React/React DOM 19.2.8, Vite 8.2.2, TypeScript 6.0.3, Vitest 5.0.0, jsdom 30.0.1, and Oxlint 1.80.0.
- Docker Desktop 4.88.1 (237512), Engine 29.7.2, Compose 5.4.0; existing `linux/arm64` images with Prometheus 3.13.3 and Blackbox Exporter 0.28.0.

The following regression commands passed before and after the integrated scenarios:

```bash
dotnet test VenueNetworkOperationsConsole.sln --no-restore
corepack npm@11.19.1 --prefix src/VenueOps.Web test
```

| Suite | Passed | Failed / skipped |
|---|---:|---:|
| Backend: Prometheus client | 86 | 0 / 0 |
| Backend: simulator | 3 | 0 / 0 |
| Backend total | **89** | **0 / 0** |
| Frontend: overview | 15 | 0 / 0 |
| Frontend: history | 61 | 0 / 0 |
| Frontend: API helpers | 12 | 0 / 0 |
| Frontend total | **88** | **0 / 0** |

The existing gates also passed sequentially before and after the scenarios:

```bash
bash tests/viability/verify.sh
bash tests/milestone2/verify.sh
bash tests/milestone3/verify.sh
```

Every existing assertion and cleanup action was preserved. Temporary invocation wrappers outside the repository replaced known Compose startup with explicitly project-scoped `up --no-build --pull never --detach --wait` for the four Venue services, added `--pull never` to the two promtool runs, and routed npm through Corepack npm 11.19.1. Frontend lint and production build passed through the M2/M3 gates. Each gate restored healthy APs and inactive alerts. The wrappers were removed.

## Hosted and rendered verification

The frontend ran under temporary Vite bound to `127.0.0.1`, using the unchanged `/api` proxy target `http://localhost:8080`. Installed Chrome 153.0.8010.36 ran headlessly with a fresh temporary profile and IPv4-loopback-only debugging. No browser dependency was installed and no existing browser profile was used. The page, App transform, overview, and history loaded successfully. Rendered DOM, request records, and screenshots were inspected.

### A. Simulated AP outage and recovery

Only the existing `PUT /simulation/access-points/ap-001` simulator endpoint was changed, first to `{"scenario":"offline"}` and then to `{"scenario":"healthy"}`. Cleanup was registered before the change.

During the outage, overview remained HTTP 200. The AP had zero clients, null RF/latency/loss measurements, and a firing `VenueApDown` alert. Zone A reached a 0.5 operational ratio and 35 clients. Scrape and Blackbox probe results remained healthy. The browser displayed Offline, zero clients, and Not observed measurements.

Recovery restored 42 AP clients, Zone A ratio 1 and 77 clients, observed measurements, and an inactive alert. The browser recovered and hosted history retained this scenario's offline observations. This was a simulated AP failure with a functioning monitoring platform.

### B. Browser request ownership

Chrome request interception delayed an original overview request and then an original history request for approximately 12 seconds, one view at a time. URLs, payloads, and response content were unchanged.

Both delays crossed two five-second polling ticks. Each affected view kept only one request pending, the other view continued successfully, overview manual refresh was disabled while busy, and release produced no queued burst. Normal polling resumed.

Pending history requests were exercised through AP selection A → B → A and a window change. Obsolete browser requests were cancelled, old-selection content disappeared, and only current-selection history was rendered. Requests whose promises deliberately settle despite abort remain component-test evidence, not a claim from this browser scenario.

### C. Prometheus dependency failure and recovery

Only the existing Venue Prometheus container was paused. Unconditional unpause cleanup and an independent 90-second maximum-pause safeguard were armed beforehand. The successful failure/recovery scenario paused Prometheus for approximately **26.2 seconds**; no container was stopped, recreated, or rebuilt.

All lifecycle commands used the explicit Compose project and repository Compose file. The failure and recovery actions were:

```bash
# Run from the repository root, under the pre-armed cleanup/watchdog controller.
docker compose --project-name venue-network-operations-console --file compose.yaml pause prometheus
docker compose --project-name venue-network-operations-console --file compose.yaml unpause prometheus
```

Requests issued after pause confirmation established these hosted contracts:

| Endpoint | HTTP result during pause | Body / title |
|---|---|---|
| `/health/live` | 200, text/plain | `Healthy` |
| `/api/viability` | 503, application/problem+json | `Prometheus telemetry is unavailable` |
| `/api/operations/overview` | 503, application/problem+json | `Prometheus telemetry is unavailable` |
| `/api/operations/access-points/ap-001/history?window=15m` | 503, application/problem+json | `Prometheus history is unavailable` |

Each Problem Details response had `status: 503` and non-empty detail, with no fabricated success dataset. The three data requests completed in approximately **3.03–3.04 seconds**, within the 10-second observation deadline, through the existing three-second HttpClient timeout.

The browser showed both refresh-failure banners and identified retained data as the most recent successful response. Retained data and displayed timestamps/bounds did not falsely advance. AP/window changes cleared previous-selection data and errors; returning A → B → A did not resurrect an old snapshot. A fresh page showed initial failure without invented AP/zone data.

Explicit unpause was verified before cancelling the safeguard. Readiness returned, all five expected `up` series were healthy, and `timestamp(up)` confirmed new scrapes after unpause. All three data endpoints returned 200. Both browser pages recovered through polling, errors cleared, timestamps advanced, and selection identity remained correct.

On this Docker version, paused Prometheus inspection returned an empty `NetworkSettings.Ports` map. Its configured `HostConfig.PortBindings` and all four actual host listeners remained IPv4 loopback. The runtime port map returned unchanged after unpause. This observation was checked directly rather than treating the empty map as proof that publication disappeared.

### D. Hosted history and rendered coverage

Actual browser response bodies were matched to the displayed AP/window and time domain. Ordered unique timestamps, cell counts, resolution widths, offline counts, adjacent state-change summaries, zero/null semantics, and accessible gap descriptions were verified across all four windows. Rendered geometry differed from timestamp calculations by less than 0.02 CSS pixels.

These were the observed rolling responses, not fixed future point-count expectations:

| Window | Step | Observations | Offline | Adjacent state changes | Leading gap | Internal gap intervals |
|---|---:|---:|---:|---:|---|---:|
| 15m | 5s | 181 | 10 | 8 | No | 0 |
| 1h | 15s | 241 | 3 | 4 | No | 0 |
| 6h | 60s | 205 | 2 | 4 | Yes | 6 |
| 24h | 300s | 122 | 0 | 0 | Yes | 13 |

Natural leading/internal gaps remained neutral Not observed coverage. No long outage was created to manufacture sparse data. These live responses did not contain opposite-state neighbors across a gap; that adversarial transition case remains deterministic component-test evidence.

## Infrastructure and historical preservation

The four publications remained `127.0.0.1:8080`, `127.0.0.1:8081`, `127.0.0.1:9090`, and `127.0.0.1:9115`, with no wildcard or IPv6 host publication. Container identities, image IDs/references/platforms/available RepoDigests, resolved Compose configuration, and the existing Compose network were preserved. Internal service-name communication continued to work.

The named volume `venue-network-operations-console_prometheus-data`, created `2026-08-27T01:51:32Z`, retained identical metadata and its `/prometheus` mount. Retention remained seven days.

A fixed pre-injection query for `venue_ap_operational{ap_id="ap-001"}`, with `start=1789136371`, `end=1789136671`, and `step=5s`, returned identical labels, timestamps, and values for all **61 points** after verification. Newly collected samples were not substituted. These dated query parameters remain subject to normal retention expiry.

The final stack had four running services, no paused containers, healthy configured healthchecks, four healthy simulated APs, an inactive AP-down alert, five healthy scrape targets, and a successful Blackbox probe. Temporary Vite/Chrome processes, the browser profile, interception, and verification wrappers were removed. No dependency installation, image pull/build, network/volume replacement, or application/configuration change was needed.

## Evidence boundaries and limitations

- **Unit/component regression:** Controlled client responses, asynchronous races, adversarial abort settlements, and deterministic sparse-history fixtures; 89 backend and 88 frontend passes.
- **Hosted service integration:** Actual API, simulator, Prometheus, and Blackbox behavior during AP failure and dependency timeout/recovery.
- **Rendered browser end-to-end behavior:** Actual Chrome rendering and interaction through Vite, API, and monitoring dependencies, including failure, retention, selection, and recovery.
- **Infrastructure inspection:** Configured/runtime bindings, actual listeners, image/network/volume identity, and fixed historical-data comparison.

The repository records concise dated results; large response logs and browser artifacts are not committed. Earlier milestone evidence remains historical.

Still unproven or deferred:

- Real wireless-controller integration, real venue telemetry, and venue-scale/high-density Wi-Fi performance.
- Comprehensive freshness policy. Prometheus's five-minute lookback can reuse earlier samples; range-query timestamps are evaluation positions, not a raw scrape ledger.
- Frontend request timeout/retry policy; a request that never settles can keep its view busy.
- A cross-browser matrix; rendered verification used one installed Chrome version.
- Production deployment/security, authentication, TLS, and remote access.
- Original-build .NET base-image digests and reproducibility of future local image builds.

Hosted failure injection covered dependency timeout. Malformed-response permutations remain typed-client regression evidence. No later feature milestone is implemented by this closeout.
