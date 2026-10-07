# ARCHITECTURE.md — streamhub

## Big picture

```
 Twitch ─┐                                  ┌─> Dashboard (React, localhost)
YouTube ─┼─> Connectors ─> Normalizer ─> BUS ┼─> Overlay modules (OBS Browser Sources)
   Kick ─┘                                   │
                                             └─> OBS Bridge <──> OBS (obs-websocket v5)
                                                     │
                                             Sequencer (scripted cues)
```

Everything is an **event on one in-process bus**, mirrored to WebSocket clients.
The hub is the only process that holds platform tokens and the OBS connection.

## Components

### 1. Event bus (`apps/hub/src/bus`)
- In-process typed emitter + WebSocket fan-out at `ws://127.0.0.1:4747/ws` (config key `HUB_PORT`).
- Clients subscribe by topic: "obs." is a prefix, "chat.message" is exact, "*" is everything. On subscribe the hub sends the latest retained state (see EVENTS.md).
- Clients may publish only event types their manifest allows (see Modules).
- Keeps a ring buffer of the last 200 `chat.message` events so a reloaded overlay/dashboard can backfill (`{"op":"history","topic":"chat.message","limit":50}`).

### 2. Connectors (`apps/hub/src/connectors`)
Common interface:
```ts
interface Connector {
  platform: Platform;               // 'twitch' | 'youtube' | 'kick'
  start(): Promise<void>;           // connect, begin emitting
  stop(): Promise<void>;
  status(): ConnectorStatus;        // 'disconnected'|'connecting'|'live'|'offline'|'error'
}
```
Each connector converts platform payloads to `ChatMessage` (see EVENTS.md) and emits `chat.message`, `chat.deleted`, `platform.status`.
Reconnect with exponential backoff (1s → 60s cap, jitter).

| Platform | Approach | Notes |
|---|---|---|
| Twitch | EventSub over WebSocket, hub-direct | EventSub WS + Device Code Flow (docs/setup/twitch.md) |
| YouTube | Data API v3 live chat, hub-direct | streamList gRPC, polling fallback; BYO Google project (docs/setup/youtube.md) |
| Kick | Official webhooks via the **relay** (`apps/relay`, M3) | Opt-in unofficial Pusher fallback. |
| X | Video only (RTMP via multi-rtmp). Chat deferred: Enterprise/approval-only API, see `docs/connectors/x.md`. | |

#### Verify before building
Platform APIs change. Before writing each connector, the agent must read the current official docs and confirm: auth flow + scopes, how to receive chat in real time, rate limits/quota, and ToS constraints. Record findings in `docs/connectors/<platform>.md`.

### 3. OBS bridge (`apps/hub/src/obs`)
- Uses `obs-websocket-js` against OBS 28+ built-in websocket server (`OBS_WS_URL`, `OBS_WS_PASSWORD`).
- Exposes commands on the bus (dashboard/sequencer publish these):
  - `obs.cmd.setScene { scene }`
  - `obs.cmd.startStream {}` / `obs.cmd.stopStream {}`
  - `obs.cmd.setSourceVisible { scene, source, visible }`
- Re-emits OBS state: `obs.scene.changed`, `obs.stream.state`, `obs.connection`.
- **Multistreaming is OBS's job**: obs-multi-rtmp with "Sync start/stop with OBS" on every target, so the hub's start/stop drives all destinations. The hub only sees the main output's state. Setup: docs/multistream.md.

### 4. Scene transitions
> Not part of the base. Ships later as a module (see the spec).

Two supported kinds, chosen per transition:
1. **Native OBS transitions** (cut, fade, stinger video with alpha): hub just calls `setScene`; OBS applies its configured transition.
2. **Overlay transitions** (animated web page, e.g. `modules/transition-wipe`): lives as a Browser Source on a *top-level "FX" scene nested in every show scene* (or as a global source). Flow:
   ```
   show.transition.play {id:'wipe', durationMs:1200, midpointMs:600}
      → overlay animates in
      → at midpoint hub sends obs.cmd.setScene (cut)
      → overlay animates out
      → overlay publishes show.transition.done
   ```
   The hub drives timing from `midpointMs`; the overlay does not call OBS itself.

### 5. Sequencer (`apps/hub/src/sequencer`)
> Not part of the base. Ships later as a module (see the spec).

Named, scripted cue lists loaded from `config/sequences/*.json`, triggered from the dashboard (or a hotkey later).
```json
{
  "id": "stream-intro",
  "label": "Start show",
  "steps": [
    { "do": "obs.cmd.setScene", "args": { "scene": "Starting Soon" } },
    { "do": "obs.cmd.startStream" },
    { "wait": 60000 },
    { "do": "show.transition.play", "args": { "id": "wipe", "durationMs": 1200, "midpointMs": 600, "toScene": "Main Cam" } }
  ]
}
```
Step types: `do` (publish an event), `wait` (ms), `waitFor` (event type, optional timeout). A running sequence can be cancelled (`show.sequence.cancel`).

### 6. Dashboard (`apps/dashboard`)
Served by the hub at `http://127.0.0.1:4747/`. The Tauri desktop shell (`apps/desktop`) loads the same dashboard from its own bundled hub, with no changes to the event or WebSocket contracts. See `docs/desktop.md` for lifecycle, packaging, and configuration.
- **Unified chat:** one column, platform color tag + icon, author, text with emotes; filters by platform; click a message → "Feature" (publishes `show.feature.set`).
- **Scenes:** buttons for every OBS scene, current scene highlighted.
- **Sequences:** buttons for each sequence, running state, cancel.
- **Status bar:** per-connector status, OBS connection, stream state, uptime.
- Script/teleprompter view is **not** in the base (planned module).

### 7. Modules (`modules/*`)
A module is a static web bundle + manifest, served at `http://127.0.0.1:4747/m/<id>/`.
```json
{
  "id": "featured-message",
  "name": "Featured message",
  "version": "0.1.0",
  "overlays": [{ "id": "main", "path": "index.html", "width": 1920, "height": 1080 }],
  "subscribes": ["show.feature."],
  "publishes": [],
  "settings": { "theme": { "type": "string", "default": "dark" } }
}
```
- The hub discovers modules at startup by scanning `modules/*/manifest.json`.
- Overlays connect with `@streamhub/overlay-sdk`:
  ```ts
  const hub = connect({ module: 'featured-message' });
  hub.on('show.feature.set', (e) => render(e.payload.message));
  ```
- The hub enforces `subscribes` / `publishes` per module (it identifies the module from the `module` query param + a per-session token the hub injects into the served HTML).
- This contract is what gets vibecoded live: **one stream = one new module folder.**

### 8. Relay (`apps/relay`, M3)
A hosted, self-hostable Cloudflare Worker that receives Kick webhooks and does Kick OAuth, and forwards events to the hub over a WebSocket the hub opens outbound. It is the only internet-facing component. Design: docs/superpowers/specs/2026-10-01-streamhub-base-design.md §4.3.

### 9. Cameras (`apps/hub/src/cameras`, `modules/camera-*`)
Video still flows camera → OBS; the hub only switches and tunes.
- Cameras are listed in `.streamhub/cameras.json`, each bound to one OBS scene and the OBS source that shows it. `camera.cmd.take` switches OBS to that scene; `camera.state` (retained per camera) carries status, on-air, telemetry and controls.
- **OBS-side controls** work for every camera, driverless included: a "streamhub color" color-correction filter (brightness, contrast, saturation, gamma), crop, mirror, reset, and "create scene" when the scene is missing.
- **Device controls** come from a driver: a Node process in `modules/camera-<model>/` (manifest `"driver": { "entry": "src/main.ts" }`) built on `@streamhub/camera-sdk`. The hub spawns it with a minimal environment and a per-run token, it connects to `/ws?driver=<id>&token=<t>`, and it may only send and receive `camera.driver.*` for its own cameras. Drivers describe their controls (select, range, toggle, action), so the dashboard renders new models without changes. Crashed drivers restart with backoff; a missing driver shows the camera as "not installed" and OBS-side controls keep working.
- Shipped: `camera-gopro` (HERO12 over USB, Open GoPro HTTP API). The Sony A6400 is OBS-only (no public control API). Guides: `docs/cameras/`.

## Config & secrets
- `.env` (gitignored): `HUB_PORT`, `OBS_WS_URL`, `OBS_WS_PASSWORD`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`, `YOUTUBE_API_KEY` / OAuth creds, `KICK_*`.
- `config/` (committed, no secrets): sequences, platform colors, enabled connectors.
- Desktop builds use the OS application-data directory for `.env` and `.streamhub/secrets.json`; development keeps the repo paths. OS keychain storage is deferred. OAuth continues in the system browser.

## Security
- Listen on 127.0.0.1 only. Reject WebSocket connections whose Origin is not the hub itself (or the Vite dev server in development). OBS Browser Sources load overlays from the hub, so they send the hub's origin. Modules additionally need their session token (M4).
- Treat all chat text as untrusted: render as text, never `innerHTML`.

## Out of scope for the base
Teleprompter/script view, chat-triggered effects, votes/polls, sound playback, X integration, AI features.
