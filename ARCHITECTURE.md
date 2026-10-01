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
- In-process typed emitter + WebSocket fan-out at `ws://127.0.0.1:4455/ws`
  (pick a port that does not clash with OBS's default 4455 — use **4747**; config key `HUB_PORT`).
- Clients subscribe by topic prefix: `{"op":"subscribe","topics":["chat.","show."]}`.
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

| Platform | Approach (verify first) | Notes |
|---|---|---|
| Twitch | EventSub over WebSocket, `channel.chat.message` subscription, user token | IRC (e.g. tmi.js) is an acceptable fallback for v0. |
| YouTube | Data API v3: find active broadcast → `liveChatId` → poll `liveChatMessages` respecting `pollingIntervalMillis` | **Quota is the constraint.** Check whether a streaming chat endpoint is currently available; prefer it over polling if so. |
| Kick | Official public API if chat events are available without a public webhook URL; otherwise investigate the realtime websocket used by the web client | Webhooks need a public URL → would require a tunnel. Do a spike before committing. |
| X | Out of scope for v0 (no practical live-chat API). | |

#### Verify before building
Platform APIs change. Before writing each connector, the agent must read the current official docs and confirm: auth flow + scopes, how to receive chat in real time, rate limits/quota, and ToS constraints. Record findings in `docs/connectors/<platform>.md`.

### 3. OBS bridge (`apps/hub/src/obs`)
- Uses `obs-websocket-js` against OBS 28+ built-in websocket server (`OBS_WS_URL`, `OBS_WS_PASSWORD`).
- Exposes commands on the bus (dashboard/sequencer publish these):
  - `obs.cmd.setScene { scene }`
  - `obs.cmd.startStream {}` / `obs.cmd.stopStream {}`
  - `obs.cmd.setSourceVisible { scene, source, visible }`
- Re-emits OBS state: `obs.scene.changed`, `obs.stream.state`, `obs.connection`.
- **Multistreaming is OBS's job** (multi-RTMP plugin or a relay service). The hub only starts/stops.

### 4. Scene transitions
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
Served by the hub at `http://127.0.0.1:4747/`.
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

## Config & secrets
- `.env` (gitignored): `HUB_PORT`, `OBS_WS_URL`, `OBS_WS_PASSWORD`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`, `YOUTUBE_API_KEY` / OAuth creds, `KICK_*`.
- `config/` (committed, no secrets): sequences, platform colors, enabled connectors.
- Later (Tauri shell): move tokens to the OS keychain and do OAuth in-app.

## Security
- Listen on 127.0.0.1 only. Reject WS connections whose `Origin` is not the hub itself or OBS's browser source (OBS uses `null`/file origins — allow `null` only with a valid session token).
- Treat all chat text as untrusted: render as text, never `innerHTML`.

## Out of scope for the base
Teleprompter/script view, chat-triggered effects, votes/polls, sound playback, Tauri packaging, X integration, AI features.
