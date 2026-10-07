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
| `camera.driver.state` | `{ id, status, detail?, telemetry?, controls, obsInput?: { kind, settings } }` (driver → hub) |
| `camera.driver.cmd.set` | `{ id, key, value }` (hub → driver) |

OBS-side control keys: `obs.brightness`, `obs.contrast`, `obs.saturation`, `obs.gamma` (a `streamhub color` Color Correction filter the hub manages on the source), `obs.mirror`, `obs.cropLeft|Right|Top|Bottom` (the source's transform in the camera scene), `obs.reset`, and `obs.createScene` (offered when the scene or source is missing and the driver supplied `obsInput`).

`camera.driver.*` events are only exchanged between the hub and the driver that owns the camera. Drivers connect to `/ws?driver=<moduleId>&token=<token>` without an Origin header; the token is handed to the driver process by the hub at launch. A driver may publish only `camera.driver.state` for its own camera ids and receives only `camera.driver.cmd.set` for them.

## Module events
Modules publish under `module.<moduleId>.<action>` only, and only types listed in their manifest `publishes`.

## WebSocket control ops (client → hub)
```jsonc
{ "op": "subscribe",   "topics": ["chat.", "obs.scene.changed", "*"] } // "x." = prefix, "x.y" = exact, "*" = all
{ "op": "unsubscribe", "topics": ["chat."] }
{ "op": "publish",     "event": { "type": "...", "payload": { } } }       // hub fills id/ts/source
{ "op": "history",     "reqId": "r1", "topic": "chat.message", "limit": 50 } // limit 1–200, default 50
```
Hub → client: envelopes, plus
- `{ "op": "error", "code": "bad_json"|"bad_op"|"bad_payload"|"forbidden", "message": string }`; the connection stays open.
- `{ "op": "history-result", "reqId": string, "events": Envelope[] }`

**Retained state:** on `subscribe`, the hub immediately sends the latest `obs.connection`, `obs.scenes.list`, `obs.scene.changed`, `obs.stream.state`, `relay.connection`, `platform.status` (one per platform), `connections.state` (one per platform) and `camera.state` (one per camera) that match the new topics, oldest first. A reloaded dashboard is correct at once.

**Limits:** frames over 64 KB close the connection (code 1009). Dashboard clients may publish only `obs.cmd.*`, `show.*`, `connections.cmd.*` and `camera.cmd.*`, and never receive `camera.driver.*`.
