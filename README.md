# Venue Network Operations Console

This portfolio project simulates network operations for a fictional convention venue while using a real local monitoring pipeline. Prometheus collection, PromQL evaluation, alert state, Blackbox HTTP probing, API queries, and application health measurements are genuine local operations; AP and RF controller telemetry is explicitly simulated.

Milestone 1 proved the telemetry pipeline end to end. Milestone 2 added a fixed all-AP/all-zone API contract and a minimal React/TypeScript operations overview. Milestone 3 adds bounded Prometheus range queries and an AP history panel with explicit missing-observation gaps.

Milestone 4 hardens dependency validation, frontend request ownership, sparse-history rendering, and IPv4-loopback container publication. Integrated verification covers hosted dependency failure, rendered frontend recovery, and preservation of monitoring data.

Milestone 5 adds deterministic synthetic event-day degradation with manual positioning and approximately 11-minute automatic playback. Prometheus collection and alert evaluation, API quality classification, and the existing overview/history show buildup, degradation, and recovery. See the [Milestone 5 model, demo, and verification evidence](docs/milestone-5.md).

Milestone 6 adds PostgreSQL-backed durable network incidents created from current conditions, with immutable captured evidence, investigation/monitoring/resolution/reopening, notes and responder/team labels. Retry-safe creation and workflow commands, optimistic concurrency, and bounded discovery support the operator-facing list/detail/workflow UI. Captured incident evidence remains separate from current telemetry. See the [Milestone 6 workflow, demo, and verification evidence](docs/milestone-6.md).

## Local development

Before first database initialization, configure the ignored private `.env` from `.env.example` with a local-only password and restrict it to mode `0600`. For an existing incident-data volume, preserve the same credential; do not overwrite it. See [database lifecycle](docs/milestone-6.md#database-lifecycle).

Initial setup: build and start the monitoring stack:

```bash
docker compose up --build --detach --wait
```

Apply the [explicit incident migration step](docs/milestone-6.md#database-lifecycle) after initial setup or an incident schema upgrade. Ordinary API startup does not auto-migrate.

Use the maintained Node 22.23.2 environment and project npm 11.19.1 through Corepack. From the repository root, provision and start the frontend in a second terminal:

```bash
corepack npm@11.19.1 --prefix src/VenueOps.Web ci
corepack npm@11.19.1 --prefix src/VenueOps.Web run dev -- --host 127.0.0.1
```

Open <http://127.0.0.1:5173>. For subsequent event demonstrations with existing dependencies and images, use the [Milestone 5 demo](docs/milestone-5.md#how-to-demo) without reinstalling or rebuilding.

## Documentation

- [Milestone 1 viability proof](docs/viability.md)
- [Milestone 2 operations overview](docs/milestone-2.md)
- [Milestone 3 access point history](docs/milestone-3.md)
- [Milestone 4 integrated verification](docs/milestone-4.md)
- [Milestone 5 event-day load and degradation](docs/milestone-5.md)
- [Milestone 6 incident triage and response](docs/milestone-6.md)
