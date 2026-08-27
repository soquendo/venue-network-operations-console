# VenueOps.Web

This React/TypeScript client polls fixed Venue API endpoints every five seconds. It displays the Milestone 2 AP/zone operations overview and the Milestone 3 bounded AP history response, including explicit gaps for unavailable observations.

Start the Docker monitoring stack from the repository root, then run:

```bash
cd src/VenueOps.Web
npm install
npm run dev
```

Vite serves the client at <http://localhost:5173> and proxies `/api` requests to the Venue API at `http://localhost:8080` during development.
