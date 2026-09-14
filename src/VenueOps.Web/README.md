# VenueOps.Web

This React/TypeScript client presents venue monitoring and incident response. It displays synthetic AP/zone telemetry, bounded AP history with explicit unobserved gaps, and durable incidents with captured evidence, current telemetry and response chronology. Overview polling runs every five seconds; mounted AP history owns its polling, while incident list/detail reads use explicit loading and refresh.

Follow the repository-root [local-development instructions](../../README.md#local-development) for private configuration, service startup, explicit incident migrations and frontend setup. Use maintained Node 22.23.2 and project npm 11.19.1 through Corepack; no personal installation path is required.

The documented Vite command serves the client at <http://127.0.0.1:5173>. The existing development configuration proxies `/api` requests to the Venue API at `http://localhost:8080`.

Run the [frontend checks from the repository root](../../README.md#verification-and-limitations).

The tests use Vitest 5.0.0 with the existing Vite configuration. Component tests select jsdom 30.0.1 per file and use React's `act` and `createRoot`, controlled fetch responses, and fake timers. No running API or Docker stack is needed for these tests.
