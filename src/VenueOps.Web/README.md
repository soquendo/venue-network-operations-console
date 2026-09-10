# VenueOps.Web

This React/TypeScript client polls fixed Venue API endpoints every five seconds. It displays the Milestone 2 AP/zone operations overview and the Milestone 3 bounded AP history response, including explicit gaps for unavailable observations.

Start the Docker monitoring stack from the repository root, then run:

```bash
cd src/VenueOps.Web
npm install
npm run dev
```

Vite serves the client at <http://localhost:5173> and proxies `/api` requests to the Venue API at `http://localhost:8080` during development.

Run frontend checks from this directory:

```bash
npm test
npm run lint
npm run build
```

The tests use Vitest 5.0.0 with the existing Vite configuration. Component tests select jsdom 30.0.1 per file and use React's `act` and `createRoot`, controlled fetch responses, and fake timers. No running API or Docker stack is needed for these tests. This setup was verified with Node 22.23.2 and npm 10.9.8.
