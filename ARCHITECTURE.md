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
| X | Video via OBS RTMP (multi-rtmp); hub-direct livestream status (broadcast state, viewers) with the streamer's own X app | Livestream API is approval-only. Chat deferred (webhook-only, unpublished pricing), see `docs/connectors/x.md`. |

#### Verify before building
Platform APIs change. Before writing each connector, the agent must read the current official docs and confirm: auth flow + scopes, how to receive chat in real time, rate limits/quota, and ToS constraints. Record findings in `docs/connectors/<platform>.md`.

### 3. OBS bridge (`apps/hub/src/obs`)
- Uses `obs-websocket-js` against OBS 28+ built-in websocket server (`OBS_WS_URL`, `OBS_WS_PASSWORD`; an address and password saved from the dashboard's Settings → OBS go to `.streamhub/secrets.json` and win over `.env`).
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
- **Tabs:** Live (scenes, sources, mixer, compact chat), Sound (mic setup, sound check, headset mixes), Chat (full-size, searchable) and Settings (side menu: General, OBS, Platforms, Alerts, Goals, Cameras, Stream keys). ⌘1–4 switch tabs and ⌘, opens Settings. Record, Start stream and the status bar stay visible on every tab. The tab to open on and the chat text size are saved in the browser (`localStorage`), not the hub; Settings is never reopened on its own, so a shared screen does not show it.
- **Pre-flight:** a toolbar button sums up checks the dashboard works out from retained state (`apps/dashboard/src/preflight.ts`; no events of its own): OBS, a stream key in OBS, platform sign-ins, mics, headsets, disk space, camera files, cameras, paused alerts. Each problem links to where it is fixed. Problems never block Start stream; its confirm then reads "GO LIVE anyway".
- **Unified chat:** one column, platform color tag + icon, author, text with emotes; filters by platform; click a message → "Feature" (publishes `show.feature.set`).
- **Scenes:** buttons for every OBS scene, current scene highlighted.
- **Sequences** (with the sequencer, not built yet): buttons for each sequence, running state, cancel.
- **Status bar:** per-connector status, OBS connection, stream state, uptime.
- Script/teleprompter view is **not** in the base (planned module).

### 7. Modules (`modules/*`)
A module is a static web bundle + manifest, served at `http://127.0.0.1:4748/m/<id>/` (`apps/hub/src/modules`). Modules get their own loopback port (`HUB_MODULES_PORT`, default 4748) so module JS — vibecoded code that renders chat text — can never act on the dashboard's origin: the dashboard WebSocket role does not exist on that port, and browsers attach each page's origin to every request, so a module page cannot reach the dashboard role on the main port either. Old `/m/<id>` URLs on the main port redirect to the modules port.
```json
{
  "id": "featured-message",
  "name": "Featured message",
  "version": "0.1.0",
  "web": "dist",
  "overlays": [{ "id": "main", "path": "index.html", "width": 1920, "height": 1080 }],
  "subscribes": ["show.feature."],
  "publishes": []
}
```
- The hub discovers modules at startup by scanning `modules/*/manifest.json` (the folder name must equal `id`; manifests without `overlays`, like camera drivers, are skipped). `modules.list` (retained) gives the dashboard each overlay's URL and whether it is built.
- It serves only files inside the module's `web` folder (default `dist`): no `..`, no dotfiles, no symlinks out. HTML and the session script are sent `no-store`; each page loads `/m/<id>/__session.js`, a virtual script that sets `window.__STREAMHUB__ = { module, token }` with a random token per hub run. Module pages run under a Content-Security-Policy that forbids inline scripts (`script-src 'self'`), plus `frame-ancestors 'none'`/`X-Frame-Options: DENY`.
- Overlays connect with `@streamhub/overlay-sdk`:
  ```ts
  const { module, token } = window.__STREAMHUB__;
  const hub = connect({ module, token });
  hub.on('show.feature.set', (e) => render(e.payload.message));
  ```
- `/ws?module=<id>&token=<t>` with a wrong token is refused (403). A module connection receives only its `subscribes` — never secrets, driver traffic, or dashboard-only state (`connections.state`, `destinations.list`, `obs.settings`) — and may publish only the `module.<id>.*` types in its `publishes`.
- `pnpm build` and `pnpm dev` build every module that has a `build` or `dev` script. Desktop builds copy each overlay module's manifest and built pages into the app.
- This contract is what gets vibecoded live: **one stream = one new module folder.** The first module is `modules/alerts` (§13).

### 8. Relay (`apps/relay`, M3)
A hosted, self-hostable Cloudflare Worker that receives Kick webhooks and does Kick OAuth, and forwards events to the hub over a WebSocket the hub opens outbound. It is the only internet-facing component. Design: docs/superpowers/specs/2026-10-01-streamhub-base-design.md §4.3.

### 9. Cameras (`apps/hub/src/cameras`, `modules/camera-*`)
Video still flows camera → OBS; the hub only switches and tunes.
- Cameras are listed in `.streamhub/cameras.json`, each bound to one OBS scene and the OBS source that shows it. `camera.cmd.take` switches OBS to that scene; `camera.state` (retained per camera) carries status, on-air, telemetry and controls.
- **OBS-side controls** work for every camera, driverless included: a "streamhub color" color-correction filter (brightness, contrast, saturation, gamma), crop, mirror, reset, and "create scene" when the scene is missing.
- **Device controls** come from a driver: a Node process in `modules/camera-<model>/` (manifest `"driver": { "entry": "src/main.ts" }`) built on `@streamhub/camera-sdk`. The hub spawns it with a minimal environment and a per-run token, it connects to `/ws?driver=<id>&token=<t>`, and it may only send and receive `camera.driver.*` for its own cameras. Drivers describe their controls (select, range, toggle, action), so the dashboard renders new models without changes. Crashed drivers restart with backoff; a missing driver shows the camera as "not installed" and OBS-side controls keep working.
- Shipped: `camera-gopro` (HERO12 over USB, Open GoPro HTTP API). The Sony A6400 is OBS-only (no public control API). Guides: `docs/cameras/`.

### 10. Recording (`apps/hub/src/recording`)
One take gives an editor everything: OBS's program recording (stream mix on track 1, isolated mics on tracks 2–6 from the audio service) and one video file per camera. OBS does all encoding.
- **Per-camera files in OBS:** the hub keeps a `streamhub ISO` filter (the third-party [Source Record](https://github.com/exeldro/obs-source-record) plugin) on each camera's OBS source, set to "Recording" mode with OBS's recording folder and a filename ending in the camera id. The files start and stop with OBS's own recording, on the same clock, so they line up in the edit. Without the plugin the dashboard says how to install it; the program recording still works.
- **Card recording:** cameras with `"record": "card"` or `"both"` get `camera.driver.cmd.record` when OBS starts or stops recording. Drivers that can (GoPro: Open GoPro shutter) report `card` state; the hub never assumes the card is recording until the driver says so.
- The service only follows OBS's record output; `recording.cmd.start|stop` are the dashboard's way in, but a take started from OBS or a hotkey is tracked the same. After a take it lists the files it found (program path from OBS, camera files by name in the recording folder, card takes by camera) and watches free space in the recording folder (warns under 20 GB, critical under 5 GB, with minutes left while recording).
- Pause is not offered: Source Record files may not pause with the main recording, and that would put the camera files out of sync.

### 11. Audio (`apps/hub/src/audio`)
Mics are OBS audio inputs; OBS mixes, filters and records them, and the hub drives OBS.
- Mics are listed in `.streamhub/audio.json` (id, name, OBS input, side). Each gets track 1 (the stream mix) plus one isolated track, 2–6 in list order, so at most five mics are isolated; later mics are mix-only. A stereo device carrying two people (interface, dual wireless receiver) becomes two inputs panned left and right.
- On every OBS connect the hub keeps a "streamhub …" filter chain on each mic (gain, noise suppression, gate, EQ, compressor, limiter; after any filters the user added), sets each mic's tracks and panning, and writes the record-track mask and track names into the OBS profile. OBS reads those when a recording starts, so changes during a recording wait (`tracksPending`). Starting and stopping recordings belongs to the recording service.
- `audio.state` (retained) carries every mic's fader, mute, monitoring, sync offset, filters and sound-check result, followed live from OBS events. `audio.levels` (up to 15/s, not retained) comes from OBS's high-volume `InputVolumeMeters` subscription.
- **Sound check:** fader to 0 dB, dynamics off, measure the median speech level for a few seconds, set the gain filter to reach the target (±20 dB per check), turn dynamics back on.
- Simulated in tests (`apps/hub/src/testing/fake-obs-audio.ts`); never run against a real OBS in tests. Guide: `docs/audio/mics.md`.

### 12. Headsets (`apps/hub/src/headsets`)
The Sound tab is a patch bay: every source (mics, camera audio, other OBS audio) wired to every output (the stream mix, then one column per headset). Per-person mixes play through the third-party [Audio Monitor](https://obsproject.com/forum/resources/audio-monitor.1186/) plugin; the hub only keeps the filters in step.
- Headsets are listed in `.streamhub/headsets.json` (name, output device name, wearer, master level, mute, one send per source, optional `mirror`), with `labels` (display names per source) and `streamSends` (stream wiring for non-mic sources) beside them. Sources are the mics, then camera audio (an OBS input named in `cameras.json`, labeled with the camera's name, joining headsets switched off), then every other OBS audio input.
- Each send that is on becomes one `streamhub hp <headsetId>` Audio Monitor filter, kept last on its source so it hears the mic filters but not the fader. Its level is `send + master` converted to the plugin's 0–100 % log-fader setting, so levels top out at 0 dB. A send that is off, a muted headset or a muted source disables the filter. Only changed settings are written, so a slider drag does not reopen the output device.
- The stream column needs no plugin: a mic flips its OBS audio track 1 (unwired mics keep their isolated recording track); any other source flips track 1 on its input and its `db` is that input's fader, echoed back on `InputVolumeChanged` so OBS-side drags show in the matrix. Track 1 writes are read-modify-write so the other tracks are preserved.
- A headset with `mirror` set ignores its own sends and plays the effective mix of the stream column (clamped to ≤0 dB, fader folded in) or of another headset; loops are refused at set time. The dashboard renders mirrored columns read-only.
- On every OBS connect the hub checks the plugin is installed (`no-plugin` otherwise), re-reads every input's tracks, fader and active state, re-applies every filter and the stream wiring, removes filters of deleted headsets, and follows input renames (settings, labels and wiring move with the input). The audio service ignores these filters.
- The desktop app bundles the Audio Monitor plugin (`apps/desktop/scripts/fetch-audio-monitor.mjs` pins a release, checks sha256, unpacks it unmodified with its GPLv2 LICENSE and a NOTICE). On start the hub (`headsets/plugin.ts`) installs it into OBS's per-user plugins folder when missing or older, never touches a foreign install, and reports `pluginPending` in the state until OBS loads it. A bare hub and Linux keep the manual install.
- Output devices are listed from `system_profiler SPAudioDataType -json` on macOS; elsewhere the user types the name. A headset whose device is missing says so.
- Simulated in tests with the same fake OBS as audio. Guide: `docs/audio/headsets.md`.

### 13. Alerts and goals (`apps/hub/src/alerts`, `modules/alerts`)
Free, self-owned alerts: events come straight from the platforms, never from StreamElements or Streamlabs.
- **Sources:** Twitch EventSub `channel.chat.notification` (subs, resubs, gift subs, raids), `channel.follow` v2 and the `cheer` field of `channel.chat.message`; YouTube live chat Super Chats, Super Stickers, new members, milestones and gifted memberships. Totals for `total` goals come from Twitch Get Channel Followers / Get Broadcaster Subscriptions and YouTube channel statistics (`platform.totals`). Details and links: `docs/connectors/alerts.md`.
- **Alert service:** drops repeats by alert id (and repeat follows by the same user), keeps the last 50, and plays one alert at a time with a 1 s gap. Pause holds the queue (up to 100); skip ends the current one; tests and replays play even when their kind is off. Per-kind text, sound, volume, duration and minimum, plus the goals and their counts, are saved to `.streamhub/alerts.json` (debounced, atomic).
- **Goals:** followers, subs or tips, per stream or channel total, over chosen platforms. Stream counts restart on go-live unless the stream was down less than 15 minutes (a crash or a restart).
- **Overlays:** `modules/alerts` builds `popup.html` (one card per alert, synthesized sounds, so no audio files) and `goal.html?goal=<id>` (one bar per goal). The pages render alert text as text only.
- **Dashboard:** Settings → Alerts (pop-up URL, pause and skip, per-kind settings with Test, recent alerts with Replay) and Settings → Goals.
- Tested with simulated EventSub frames and YouTube responses only. Guide: `docs/alerts.md`.

## Config & secrets
- `.env` (gitignored): `HUB_PORT`, `OBS_WS_URL`, `OBS_WS_PASSWORD`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`, `YOUTUBE_API_KEY` / OAuth creds, `KICK_*`.
- `config/` (committed, no secrets): sequences, platform colors, enabled connectors.
- Desktop builds use the OS application-data directory for `.env` and `.streamhub/secrets.json`; development keeps the repo paths. OS keychain storage is deferred. OAuth continues in the system browser.

## Security
- Listen on 127.0.0.1 only. Refuse HTTP and WebSocket requests whose Host header is not loopback (DNS rebinding), and reject WebSocket connections whose Origin is not the hub itself (or the Vite dev server when `NODE_ENV=development`; dev is opt-in, never the default). Browsers always send Origin, so a non-browser client (any other local process) gets the dashboard role only with the per-run dashboard token (`.streamhub/dashboard-token`, owner-only). Module pages live on their own port (§7) where the dashboard role does not exist; modules and drivers always need their session token. Responses carry `X-Frame-Options: DENY` and a CSP, and in `pnpm dev` the Vite server refuses to serve `.streamhub/`, `.env*` or `.git` (its `fs.deny`).
- Treat all chat text as untrusted: render as text, never `innerHTML`.

## Out of scope for the base
Teleprompter/script view, chat-triggered effects, votes/polls, sound playback, X integration, AI features.
