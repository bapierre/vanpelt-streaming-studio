# EVENTS.md — event contract

Single source of truth lives in `packages/shared` (TypeScript types + zod schemas). This file documents it. **If they disagree, fix both in the same commit.**

## Envelope
Every message on the bus and over WebSocket:
```ts
type Envelope<T extends string = string, P = unknown> = {
  id: string;          // ulid
  type: T;             // 'domain.action'
  ts: number;          // epoch ms, set by hub
  source: string;      // 'hub' | 'connector:twitch' | 'dashboard' | 'module:<id>' | 'sequencer'
  payload: P;
};
```

## Chat
> X is a video destination only in v0; X chat is deferred (see docs/connectors/x.md).

```ts
type Platform = 'twitch' | 'youtube' | 'kick';

type ChatAuthor = {
  id: string;               // platform user id
  name: string;             // display name
  avatarUrl?: string;
  color?: string;           // platform name color if provided
  roles: Array<'owner' | 'moderator' | 'vip' | 'subscriber' | 'member'>;
};

type ChatFragment =
  | { kind: 'text'; text: string }
  | { kind: 'emote'; name: string; url: string }
  | { kind: 'mention'; name: string }
  | { kind: 'link'; url: string };

type ChatMessage = {
  id: string;               // `${platform}:${platformMessageId}` — globally unique
  platform: Platform;
  channel: string;
  author: ChatAuthor;
  text: string;             // plain text version, always present
  fragments: ChatFragment[];
  sentAt: number;           // platform timestamp if available, else receive time
  raw?: unknown;            // debugging only
};
```

| type | payload |
|---|---|
| `chat.message` | `ChatMessage` |
| `chat.deleted` | `{ id: string }` (normalized id) |
| `chat.cleared` | `{ platform: Platform; authorId?: string }` (whole chat cleared, or one user's messages removed) |
| `relay.connection` | `{ connected: boolean; detail?: string }` |
| `platform.status` | `{ platform: Platform; status: 'disconnected'\|'connecting'\|'live'\|'offline'\|'error'; detail?: string }` |
| `platform.live` | `PlatformLive` (retained per platform; what the platform reports about our livestream, independent of OBS) |

```ts
type PlatformLive = {
  platform: Platform;
  ingest: 'active' | 'inactive' | 'unknown'; // is the platform receiving our video? unknown when its API won't tell us
  broadcast: 'none' | 'scheduled' | 'running' | 'ended'; // newest broadcast on the account
  viewers?: number;
  title?: string;
  startedAt?: number; // epoch ms
  detail?: string;
};
```
Only the X connector publishes `platform.live` today; it has no chat.

## OBS
| type | payload |
|---|---|
| `obs.connection` | `{ connected: boolean; detail?: string }` |
| `obs.scene.changed` | `{ scene: string }` |
| `obs.scenes.list` | `{ scenes: string[]; current: string }` |
| `obs.stream.state` | `{ state: 'starting'\|'live'\|'stopping'\|'stopped'; startedAt?: number }` |
| `obs.cmd.setScene` | `{ scene: string }` |
| `obs.cmd.startStream` | `{}` |
| `obs.cmd.stopStream` | `{}` |
| `obs.cmd.setSourceVisible` | `{ scene: string; source: string; visible: boolean }` |
| `obs.settings` | `{ url: string; passwordSet: boolean }` (retained; the password itself is never sent) |
| `obs.sources.list` | `{ scene: string; sources: { name: string; visible: boolean }[] }` (retained; current program scene, top source first) |
| `obs.cmd.reconnect` | `{}` (drop the OBS connection and connect again now) |
| `obs.cmd.refresh` | `{}` (re-read scenes, sources and stream state from OBS) |
| `obs.cmd.previews.watch` | `{}` (the preview lease: a dashboard showing scene previews sends it every ~5 s; the hub captures while leases arrive and stops ~12 s after the last one) |
| `obs.scene.preview` | `{ scene, image: data URL, capturedAt }` (a ~320 px thumbnail of one scene; transient: never retained, never in history) |

**Scene previews:** while a lease is fresh and OBS is connected, the hub asks OBS for `GetSourceScreenshot` of the program scene about once per second and of the other scenes round-robin about every 4 s, never with more than one request in flight, and publishes each answer as `obs.scene.preview`. The image format comes from `GetVersion`'s `supportedImageFormats` (jpg preferred, else png). A failing or disconnected OBS only skips captures; failures log once per streak. Rendering non-program scenes costs GPU in OBS; that cost is unverified on real hardware.

## Stream destinations
RTMP targets the streamer pastes once. OBS still does all streaming; the hub only stores them and can write one into OBS's main stream output.
```ts
type StreamDestination = { id: string; label: string; server: string /* rtmp(s):// */; key: string };
```
| type | payload |
|---|---|
| `destinations.list` | `{ destinations: StreamDestination[]; inObs: string \| null; obsKeySet?: boolean; detail?: string }` (retained; `inObs` is the destination OBS's main output uses, `obsKeySet` whether that output has any key, saved here or not (omitted until OBS has been asked), `detail` the last error) |
| `destinations.cmd.save` | `StreamDestination` (insert or replace by id) |
| `destinations.cmd.remove` | `{ id: string }` |
| `destinations.cmd.useInObs` | `{ id: string }` (refused while OBS is streaming) |

`destinations.list` carries stream keys: only the dashboard role receives it; the hub refuses to send it to modules. `destinations.cmd.*` is never forwarded to WebSocket clients.

## Show
| type | payload |
|---|---|
| `show.feature.set` | `{ message: ChatMessage }` |
| `show.feature.clear` | `{}` |

Transition and sequence events (`show.transition.*`, `show.sequence.*`) return with their modules after the base; they are not in packages/shared yet.

## Connections
```ts
type ConnectionState = {
  platform: Platform;
  state: 'disconnected' | 'pending' | 'connected' | 'error';
  account?: string;          // login / channel title when connected
  detail?: string;           // human-readable error or hint
  userCode?: string;         // Twitch device code to type at verificationUri
  verificationUri?: string;  // Twitch activation page
  authUrl?: string;          // YouTube: Google sign-in URL to open
  clientConfigured?: boolean;// YouTube: a BYO OAuth client is saved
};
```
| type | payload |
|---|---|
| `connections.state` | `ConnectionState` (retained per platform) |
| `connections.cmd.connect` | `{ platform: Platform }` |
| `connections.cmd.disconnect` | `{ platform: Platform }` |
| `connections.cmd.setYoutubeClient` | `{ clientId: string; clientSecret: string }` |
| `connections.cmd.setXClient` | `{ clientId: string }` (X public OAuth 2.0 client; PKCE, no secret) |
| `connections.cmd.setObs` | `{ url: string /* ws(s):// */; password?: string }` (omit `password` to keep the saved one; saved settings override `.env`) |

`connections.cmd.*` events can carry secrets: the hub handles them internally and **never forwards them to WebSocket clients**. They are not kept in history.

## Cameras
Each camera is configured in `.streamhub/cameras.json` and bound to one OBS scene and one OBS source. Device control comes from an optional **driver** (a camera module, see `docs/cameras/writing-a-driver.md`); OBS-side controls work for every camera.
```ts
type CameraControl =                       // drivers describe controls; the dashboard renders them
  | { kind: 'select'; key; label; value: string; options: { value: string; label: string }[]; hint?; disabled? }
  | { kind: 'range';  key; label; value: number; min: number; max: number; step: number; hint?; disabled? }
  | { kind: 'toggle'; key; label; value: boolean; hint?; disabled? }
  | { kind: 'action'; key; label; hint?; disabled? };       // a button; set it with value null
// key: [a-zA-Z0-9_.-]+. Keys starting with `obs.` are the hub's OBS-side controls; drivers may not use them.
// disabled: why the control can't be used right now.

type CameraStatus = 'disconnected' | 'connecting' | 'ready' | 'streaming' | 'error';

type CameraState = {
  id: string;                // slug: [a-z0-9-]+
  name: string;
  driver: string | null;     // module id, or null for an OBS-only camera
  status: CameraStatus;
  detail?: string;           // device / driver problem
  obsDetail?: string;        // the camera's OBS scene or source is missing or OBS is down
  scene: string;             // OBS scene that "Take" switches to
  onAir: boolean;            // that scene is the current program scene
  telemetry?: { battery?: number; overheating?: boolean };
  controls: CameraControl[]; // driver controls first, then OBS-side controls
};
```
| type | payload |
|---|---|
| `camera.state` | `CameraState` (retained per camera id) |
| `camera.cmd.take` | `{ id }` switch to the camera's scene |
| `camera.cmd.set` | `{ id, key, value: string \| number \| boolean \| null }` change one control |
| `camera.driver.state` | `{ id, status, detail?, telemetry?, controls, obsInput?: { kind, settings }, card?: { supported, recording, detail? } }` (driver → hub; `card` only from drivers that can record to the camera's own card) |
| `camera.driver.cmd.set` | `{ id, key, value }` (hub → driver) |
| `camera.driver.cmd.record` | `{ id, on: boolean }` (hub → driver) start or stop recording to the camera's card; sent when OBS starts or stops recording |

OBS-side control keys: `obs.brightness`, `obs.contrast`, `obs.saturation`, `obs.gamma` (a `streamhub color` Color Correction filter the hub manages on the source), `obs.mirror`, `obs.cropLeft|Right|Top|Bottom` (the source's transform in the camera scene), `obs.reset`, and `obs.createScene` (offered when the scene or source is missing and the driver supplied `obsInput`).

`camera.driver.*` events are only exchanged between the hub and the driver that owns the camera. Drivers connect to `/ws?driver=<moduleId>&token=<token>` without an Origin header; the token is handed to the driver process by the hub at launch. A driver may publish only `camera.driver.state` for its own camera ids and receives only `camera.driver.cmd.set` and `camera.driver.cmd.record` for them.

## Audio
Each mic is an OBS audio input listed in `.streamhub/audio.json`. Audio never passes through the hub: OBS mixes, filters and records it, and the hub controls OBS. Starting and stopping the recording belongs to the recording session (`recording.*`); the audio service only decides which tracks OBS records. Track 1 carries the stream mix; each of the first five mics is also routed alone to tracks 2–6 so recordings keep every voice separate. Later mics are mixed and tunable but get no isolated track (`track: null`). Setup: `docs/audio/mics.md`.
```ts
type MicFilters = {                                  // a chain of `streamhub <name>` filters on the input, in this order
  gain:       { enabled; db };                       // -30..30
  denoise:    { enabled; method: 'rnnoise' | 'speex'; suppressDb };   // suppressDb -60..0 (speex only)
  gate:       { enabled; openDb; closeDb; attackMs; holdMs; releaseMs };
  eq:         { enabled; low; mid; high };           // dB, -20..20
  compressor: { enabled; ratio; thresholdDb; attackMs; releaseMs; outputDb };
  limiter:    { enabled; thresholdDb; releaseMs };
};

type MicState = {
  id: string;                  // slug: [a-z0-9-]+
  name: string;
  input: string;               // OBS input name
  channel: 'both' | 'left' | 'right';  // side of a stereo device this mic is on
  track: number | null;        // isolated recording track 2–6
  status: 'ok' | 'missing' | 'offline';
  detail?: string;
  live: boolean;               // the input is in the program scene (audible on stream)
  volumeDb: number;            // fader
  muted: boolean;
  monitor: 'off' | 'monitor' | 'both';   // monitor = headphones only, both = headphones and output
  syncOffsetMs: number;
  filters: MicFilters;
  soundcheck?: { state: 'listening' | 'done' | 'failed'; until?; measuredDb?; gainDb?; detail? };
};

type AudioState = {
  mics: MicState[];            // config order; decides track assignment
  targetDb: number;            // speech level the sound check aims for, dBFS (-40..-6, default -20)
  recordTracks: number[];      // tracks OBS records
  recordDetail?: string;       // why the recording tracks could not be set
  tracksPending: boolean;      // OBS is recording; track changes apply to the next recording
};
```
| type | payload |
|---|---|
| `audio.state` | `AudioState` (retained) |
| `audio.levels` | `{ levels: { [micId]: { peakDb, rmsDb } } }` up to 15 per second while OBS is connected; never retained |
| `audio.devices` | `{ devices: { id, name }[], inputs: string[], detail? }` capture devices, and OBS audio inputs that are not mics yet (retained) |
| `audio.cmd.set` | `{ id, name?, volumeDb?, muted?, monitor?, syncOffsetMs?, filters?: partial MicFilters }` |
| `audio.cmd.add` | `{ name, channel?, from: { kind: 'device', device } \| { kind: 'input', input } }` create an OBS input for a device, or adopt an existing one |
| `audio.cmd.remove` | `{ id }` stop managing the mic (the OBS input and its filters stay) |
| `audio.cmd.soundcheck` | `{ id, action: 'start' \| 'cancel', seconds?: 3..30 }` measure speech and set the gain to `targetDb` |
| `audio.cmd.setTarget` | `{ targetDb }` |
| `audio.cmd.listDevices` | `{}` refresh `audio.devices` |
| `audio.cmd.nest` | `{ scene? }` add the `streamhub mics` scene to `scene`, or to every scene |

## Headsets
The Sound tab is a patch bay: every sound source (the mics, the audio of each camera, any other OBS audio) wired to every output (the stream mix, then one column per headset). Audio never passes through the hub.

Each headset is a personal mix played to one output device, listed in `.streamhub/headsets.json`. For every source sent to a headset, the hub keeps one `streamhub hp <headsetId>` filter from Exeldro's Audio Monitor plugin (`audio_monitor`) last on that source, so the headset hears it after the mic filters but before the stream fader: moving a fader never changes what a headset hears. A send's level is `db + masterDb`; the plugin can only turn a signal down, so levels top out at 0 dB. A filter is disabled while its send is off, its headset is muted, or its source is muted. Sources are the mics, then camera audio, then any other OBS audio input; new sources join every headset switched on at 0 dB, except camera audio, which joins switched off. Removing a headset removes its filters.

The **stream column** is the first output and needs no plugin: for a mic it flips OBS audio track 1 on the mic (unwired mics still record to their isolated track), for any other source it flips track 1 on that input and `db` is its OBS fader, followed live when someone drags it in OBS. A headset can **follow** the stream column or another headset (`mirror`): its own sends are then ignored and `sends` reports the effective mix, so you can hear exactly what the stream or a friend's headset hears. Labels rename any source for display only. Setup: `docs/audio/headsets.md`.
```ts
type SourceKey = `mic:${string}` | `obs:${string}`;   // mic id, or OBS input name for other audio
type Mirror = 'stream' | string;                       // or a headset id
type HeadsetSource = {
  key: SourceKey;
  name: string;
  kind: 'mic' | 'camera' | 'obs';  // camera: a camera's OBS source audio, named after the camera
  detail?: string;                 // where the sound comes from (OBS input name)
  live: boolean;                   // false while a camera is off-screen: the source is silent
};
type HeadsetState = {
  id: string;                  // slug: [a-z0-9-]+
  name: string;
  device: string;              // output device name, as the computer lists it
  owner: string | null;        // mic id of the person wearing it
  masterDb: number;            // -60..0
  muted: boolean;
  mirror: Mirror | null;       // set: plays the mirrored node's wiring; sends holds the effective mix
  status: 'ok' | 'no-plugin' | 'offline';
  detail?: string;             // e.g. "<device> is not plugged in"
  sends: Record<SourceKey, { on: boolean; db: number }>;   // db -60..0
};
type HeadsetsState = {
  plugin: boolean | null;      // Audio Monitor is installed in OBS; null until OBS has been asked
  pluginPending: boolean;      // plugin on disk (bundled with the app) but not loaded: restart OBS
  outputs: string[];           // output devices on this computer; empty when they cannot be listed
  outputsDetail?: string;
  sources: HeadsetSource[];    // mics first, then camera audio, then other OBS audio
  stream: Record<SourceKey, { on: boolean; db: number }>;  // the stream column; db -100..26
  labels: Record<SourceKey, string>;                       // display-name overrides
  headsets: HeadsetState[];    // up to 16
};
```
| type | payload |
|---|---|
| `headsets.state` | `HeadsetsState` (retained) |
| `headsets.cmd.add` | `{ name, device, owner? }` every current source starts switched on at 0 dB, camera audio off |
| `headsets.cmd.update` | `{ id, name?, device?, owner?, masterDb?, muted?, mirror? }` mirror: `'stream'`, a headset id, or null |
| `headsets.cmd.remove` | `{ id }` also removes its filters from OBS |
| `headsets.cmd.setSend` | `{ id, source, on?, db? }` refused while the headset follows another node |
| `headsets.cmd.setStream` | `{ source, on?, db? }` wire a source into the stream mix (track 1 + fader); mics take `audio.cmd.set` |
| `headsets.cmd.renameSource` | `{ source, name }` display label for any source; null clears it |
| `headsets.cmd.listOutputs` | `{}` refresh `outputs` |

## Recording
One take produces OBS's program recording (the picture the stream shows; audio track 1 is the stream mix, tracks 2–6 the isolated mics, see Audio) plus one video file per camera. OBS encodes every file; the hub never touches video. Each camera's `record` in `.streamhub/cameras.json` picks where its own file comes from: `obs` (default; a `streamhub ISO` Source Record filter the hub manages on the camera's OBS source, set to record whenever OBS records), `card` (the camera records to its own card through its driver), `both`, or `off`. The hub follows OBS's record output whoever starts it (dashboard, OBS, a hotkey). Setup: `docs/setup/recording.md`.
```ts
type CameraRecording = {
  id: string; name: string;
  mode: 'obs' | 'card' | 'both' | 'off';
  iso?: 'ready' | 'recording' | 'offline' | 'no-plugin' | 'no-source' | 'error';    // when mode is obs or both
  card?: 'ready' | 'recording' | 'unsupported' | 'offline' | 'error';                // when mode is card or both
  detail?: string;                                                                     // why a camera cannot record
};
type RecordedFile = { kind: 'program' | 'camera' | 'card'; cameraId?: string; label: string; location: string };
type RecordingSession = {
  output: 'stopped' | 'starting' | 'recording' | 'paused' | 'stopping';
  startedAt?: number;          // epoch ms the take started
  directory?: string;          // OBS's recording folder
  cameras: CameraRecording[];
  disk?: { path: string; freeBytes: number; level: 'ok' | 'low' | 'critical'; minutesLeft?: number }; // low < 20 GB, critical < 5 GB
  lastSession?: { endedAt: number; files: RecordedFile[] };  // card files are listed as "On <camera>'s card"
  detail?: string;             // e.g. OBS refused to start, or OBS is not connected
};
```
| type | payload |
|---|---|
| `recording.state` | `RecordingSession` (retained) |
| `recording.cmd.start` | `{}` start OBS recording |
| `recording.cmd.stop` | `{}` stop OBS recording (the dashboard asks for a second click) |

## Alerts and goals
Follows, subs, gift subs, cheers, tips and raids come straight from the platforms (Twitch EventSub, YouTube live chat; no third-party alert service). Connectors publish one `alert.event` each; the hub's alert service drops duplicates, keeps the last 50, and plays them one at a time on the alerts overlay (`alert.show`, then `alert.hide` after `durationMs`, then a 1 s gap). Settings and goals live in `.streamhub/alerts.json`. Sources per platform: `docs/connectors/alerts.md`. Guide: `docs/alerts.md`.
```ts
type Alert = {
  id: string;                  // `${platform}:${platform event id}`
  kind: 'follow' | 'sub' | 'resub' | 'giftsub' | 'cheer' | 'tip' | 'raid';  // sub also covers a new YouTube membership
  platform: 'twitch' | 'youtube' | 'kick';
  user: { id: string; name: string; avatarUrl?: string };  // anonymous gifts: { id: 'anonymous', name: 'Anonymous' }
  amount?: number;             // cheer: bits. tip: whole units of currency (5.5 = 5.50)
  currency?: string;           // ISO 4217, tips only
  amountText?: string;         // as the platform writes it, e.g. "$5.00"
  count?: number;              // giftsub: subs gifted. raid: viewers
  months?: number;             // resub: total months
  tier?: string;               // Twitch "1" | "2" | "3" | "Prime"; YouTube membership level name
  message?: string;
  at: number;
  test?: true;                 // from a Test button: shown, never counted toward a goal
};
type AlertKindConfig = {
  enabled: boolean;
  template: string;            // placeholders {user} {amount} {count} {months} {tier}
  sound: 'chime' | 'pop' | 'coin' | 'fanfare' | 'none';  // synthesized by the overlay
  volume: number;              // 0..1
  durationMs: number;          // 2000..30000
  minAmount: number;           // smaller cheers (bits), tips, raids (viewers), gifts (subs) are not shown; still counted
};
type AlertsConfig = { paused: boolean; kinds: Record<Alert['kind'], AlertKindConfig> };
type Goal = {
  id: string;                  // slug: [a-z0-9-]+
  label: string;
  metric: 'followers' | 'subs' | 'tips';
  scope: 'stream' | 'total';   // stream: from go-live; total: the channel's count (tips: since the goal was made)
  target: number;
  currency?: string;           // tips goals only; other currencies are not counted
  platforms: Alert['platform'][];
};
type GoalState = Goal & { current: number; approximate?: true; detail?: string };
```
Counting: followers = follows (YouTube subscribers only come in through totals). Subs = subs, gift subs (by count) and, for stream goals, resubs. Tips = tips in the goal's currency. A `total` goal is the platform's last reported total plus what arrived since. Stream goals restart at 0 when the stream goes live, unless it went down less than 15 minutes earlier.

| type | payload |
|---|---|
| `alert.event` | `Alert` (connectors) |
| `alert.show` | `{ alert, text, sound, volume, durationMs }` `text` is the rendered template |
| `alert.hide` | `{ id }` |
| `alert.recent` | `{ alerts: Alert[] (newest first, up to 50), queued }` (retained) |
| `alert.config` | `AlertsConfig` (retained) |
| `alert.cmd.test` | `{ kind }` a sample alert, shown even when its kind is off |
| `alert.cmd.replay` | `{ id }` one from `alert.recent` |
| `alert.cmd.skip` | `{}` hide the current alert now |
| `alert.cmd.pause` | `{ paused }` while paused, alerts wait in the queue (up to 100) |
| `alert.cmd.setKind` | `{ kind, enabled?, template?, sound?, volume?, durationMs?, minAmount? }` |
| `platform.totals` | `{ platform, followers?, subs?, approximate? }` (retained per platform) Twitch every 5 min (followers; subs need `channel:read:subscriptions`), YouTube every 10 min (subscribers, rounded by YouTube) |
| `goal.state` | `{ goals: GoalState[] }` up to 20 (retained) |
| `goal.cmd.save` | `Goal` add, or replace by id; changing metric, scope or currency restarts the count |
| `goal.cmd.remove` | `{ id }` |
| `goal.cmd.reset` | `{ id }` back to 0 (stream goals and tips) |

## Modules
Overlay modules are folders under `modules/` with a `manifest.json` that lists `overlays` (see ARCHITECTURE.md §7). The hub serves their built pages at `/m/<id>/` on a dedicated port (default 4748, `HUB_MODULES_PORT`) and hands each page a per-run session token through `/m/<id>/__session.js`.

| type | payload |
|---|---|
| `modules.list` | `{ modules: { id, name, version, built, overlays: { id, name, url, width, height }[] }[] }` (retained) `url` goes into an OBS Browser Source; `built` is false until the pages are built |

## Module events
Modules publish under `module.<moduleId>.<action>` only, and only types listed in their manifest `publishes`. A module page receives only the topics its manifest `subscribes` to.

## WebSocket control ops (client → hub)

**Who may connect:** `/ws` on the hub port (default 4747) assigns one of three roles. A browser page from an allowed origin (the hub's own origin; the Vite dev origin too when `NODE_ENV=development`) gets the **dashboard** role. A non-browser client (no `Origin` header) gets the dashboard role only with `?token=<dashboard-token>` — a random token per hub run, written owner-only to `.streamhub/dashboard-token`. Drivers use `?driver=<id>&token=<t>` (no Origin), module pages use `?module=<id>&token=<t>` on the modules port, where the dashboard role does not exist. Requests with a non-loopback `Host` header are refused (DNS-rebinding guard).
```jsonc
{ "op": "subscribe",   "topics": ["chat.", "obs.scene.changed", "*"] } // "x." = prefix, "x.y" = exact, "*" = all
{ "op": "unsubscribe", "topics": ["chat."] }
{ "op": "publish",     "event": { "type": "...", "payload": { } } }       // hub fills id/ts/source
{ "op": "history",     "reqId": "r1", "topic": "chat.message", "limit": 50 } // limit 1–200, default 50
```
Hub → client: envelopes, plus
- `{ "op": "error", "code": "bad_json"|"bad_op"|"bad_payload"|"forbidden", "message": string }`; the connection stays open.
- `{ "op": "history-result", "reqId": string, "events": Envelope[] }`

**Retained state:** on `subscribe`, the hub immediately sends the latest `obs.connection`, `obs.scenes.list`, `obs.scene.changed`, `obs.stream.state`, `obs.settings`, `obs.sources.list`, `destinations.list`, `relay.connection`, `platform.status` and `platform.live` (one per platform), `connections.state` (one per platform), `camera.state` (one per camera), `audio.state`, `audio.devices`, `headsets.state`, `recording.state`, `alert.config`, `alert.recent`, `goal.state`, `platform.totals` (one per platform) and `modules.list` that match the new topics, oldest first. A reloaded dashboard is correct at once.

**Limits:** frames over 64 KB close the connection (code 1009); a client may hold at most 256 topic subscriptions; a client 8 MB behind is disconnected (droppable events like `audio.levels` are skipped past 256 KB); dead connections are probed every 30 s. Dashboard clients may publish only `obs.cmd.*`, `show.*`, `connections.cmd.*`, `camera.cmd.*`, `destinations.cmd.*`, `audio.cmd.*`, `recording.cmd.*`, `headsets.cmd.*`, `alert.cmd.*` and `goal.cmd.*`, and never receive `camera.driver.*`. Module pages (`/ws?module=<id>&token=<t>` on the modules port) follow their manifest instead, and never receive `connections.state`, `destinations.list` or `obs.settings` even if their manifest subscribes to them.
