# VenueOps.Web

This React/TypeScript client presents venue monitoring and incident response. It displays synthetic AP/zone telemetry, bounded AP history with explicit unobserved gaps, and durable incidents with captured evidence, current telemetry and response chronology. Overview polling runs every five seconds; mounted AP history owns its polling, while incident list/detail reads use explicit loading and refresh.

Follow the repository-root [local-development instructions](../../README.md#local-development) for private configuration, service startup, explicit incident migrations and frontend setup. Use maintained Node 22.23.2 and project npm 11.19.1 through Corepack; no personal installation path is required.

The documented Vite command serves the client at <http://127.0.0.1:5173>. The existing development configuration proxies `/api` requests to the Venue API at `http://localhost:8080`.

## Demo scenarios

In local Vite development, open **Demo scenarios** on Monitoring. Browse the five presets, select one, then explicitly **Apply scenario**. Selection does not change the simulator. **Run event day** starts approximately 11 minutes of automatic playback; **Restart event day** begins again at minute 0 and clears AP overrides. Finish with **Reset to baseline**.

The development-only `/simulation` proxy uses the fixed local simulator at `http://127.0.0.1:8081`; production builds and preview have no demo panel or simulator forwarding route. This is availability scoping, not authentication. Continue using loopback-only local startup.

These controls change shared synthetic state, including changes visible to other tabs or terminal clients. Multiple-command presets are sequential, not atomic. Confirmed command steps and simulator readback are separate from collected monitoring and real alert evaluation. Partial or uncertain failures stop the sequence; review status before deliberately applying again or resetting. Start is never automatically retried.

**Refresh simulator status** discovers external changes. Status also refreshes on panel opening, before/after commands, and every five seconds while visible automatic playback is running. **Status checked** is browser retrieval time. Existing monitoring/history polling remains independent, so measurements and alerts can take time to catch up. Incidents, captured evidence and monitoring history are retained after reset; newly collected demo samples become normal history.

Run the [frontend checks from the repository root](../../README.md#verification-and-limitations).

The tests use Vitest 5.0.0 with the existing Vite configuration. Component tests select jsdom 30.0.1 per file and use React's `act` and `createRoot`, controlled fetch responses, and fake timers. No running API or Docker stack is needed for these tests.
