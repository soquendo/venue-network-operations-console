# Venue Network Operations Console

This portfolio project simulates network operations for a fictional convention venue while using a real local monitoring pipeline. Prometheus collection, PromQL evaluation, alert state, Blackbox HTTP probing, API queries, and application health measurements are genuine local operations; AP and RF controller telemetry is explicitly simulated.

Milestone 1 proved the telemetry pipeline end to end. Milestone 2 added a fixed all-AP/all-zone API contract and a minimal React/TypeScript operations overview. Milestone 3 adds bounded Prometheus range queries and an AP history panel with explicit missing-observation gaps.

## Local development

Start the monitoring stack:

```bash
docker compose up --build --detach --wait
```

Start the frontend in a second terminal:

```bash
cd src/VenueOps.Web
npm ci
npm run dev
```

Open <http://localhost:5173>.

## Documentation

- [Milestone 1 viability proof](docs/viability.md)
- [Milestone 2 operations overview](docs/milestone-2.md)
- [Milestone 3 access point history](docs/milestone-3.md)
