# Milestone 2: Operations Overview

Milestone 2 expands the proven telemetry path into one small operator-facing read model and a minimal React client:

```text
Simulator + Blackbox Exporter -> Prometheus -> Venue API -> React overview
```

The goal is not a finished dashboard. It is to prove that the application can map all four APs and both zones into a stable domain response, represent missing observations honestly, and refresh a browser view without bypassing Prometheus.

## API contract

`GET /api/operations/overview` returns:

- Four AP observations with zone, operational state, clients, RF utilization, management latency/loss, and alert state.
- Two zone summaries with derived operational ratios and client totals.
- The measured Blackbox HTTP probe result.
- The measured Prometheus scrape result for the simulator.
- Source classifications and observation timestamps.

The API owns fixed PromQL queries and response mapping. The React client does not send PromQL or read simulator state directly.

When an AP is offline, it stays in the response with `operational: false` and `clients: 0`. RF, latency, and packet-loss fields become `null` because they are unavailable observations, not measured zeros. Missing required Prometheus series cause HTTP 503 Problem Details rather than a partial or fabricated overview.

## Run locally

Start the monitoring stack from the repository root:

```bash
docker compose up --build --detach --wait
```

In a second terminal, install the locked frontend dependencies and start Vite:

```bash
cd src/VenueOps.Web
npm ci
npm run dev
```

Open <http://localhost:5173>. During development, Vite proxies `/api` to the Venue API at `http://localhost:8080`.

The browser polls the overview every five seconds and also provides a manual refresh button. This matches Prometheus's five-second local scrape interval without adding SignalR before a demonstrated requirement exists.

## Automated verification

After `npm ci` has installed the frontend dependencies, run from the repository root:

```bash
./tests/milestone2/verify.sh
```

The gate passes only when:

1. The frontend lint and production build complete successfully.
2. The monitoring stack becomes healthy.
3. The overview returns four healthy APs, two healthy zones, and healthy measured probe/scrape states.
4. Taking `ap-001` offline keeps it in the response, changes unavailable measurements to `null`, changes Zone A to `0.5`, and maps the firing alert.
5. The measured probe and simulator scrape remain healthy during the AP failure.
6. Restoring the AP returns the overview to its healthy baseline.

## Important implementation concepts

### Application-owned DTO

The Venue API converts Prometheus's generic vector results into an operations-specific JSON contract. This keeps PromQL out of the frontend and gives the application one place to validate required labels, values, and relationships.

### Nullable observations

A nullable RF or latency field means no observation is available. A numeric zero remains a genuine measurement. Keeping these states distinct prevents the interface from presenting a failed AP as if it measured perfect conditions.

### HTTP polling

Polling asks the same HTTP endpoint for a fresh snapshot on a fixed interval. It is appropriate here because Prometheus itself updates every five seconds; a persistent SignalR connection could not make the underlying samples fresher.

### Development proxy

The browser requests `/api` from the Vite origin, and Vite forwards that path to ASP.NET during local development. This avoids development-only CORS configuration while preserving a normal same-origin browser request.

## Still deferred

- Floor-plan and topology visualization
- Javits-specific rooms or AP placement
- Incident workflows and persistence
- Historical charts and selectable time ranges
- Event-day load scenarios
- SignalR, Alertmanager, authentication, and deployment
- Visual design refinement beyond the functional overview
