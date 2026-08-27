# VenueOps.Web

This is the deliberately small Milestone 2 React/TypeScript client. It polls the fixed Venue API operations-overview endpoint every five seconds and displays AP, zone, scrape, and HTTP probe status.

Start the Docker monitoring stack from the repository root, then run:

```bash
cd src/VenueOps.Web
npm install
npm run dev
```

Vite serves the client at <http://localhost:5173> and proxies `/api` requests to the Venue API at `http://localhost:8080` during development.
