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
| `show.transition.play` | `{ id: string; durationMs: number; midpointMs: number; toScene: string }` |
| `show.transition.done` | `{ id: string }` |
| `show.sequence.start` | `{ id: string }` |
| `show.sequence.step` | `{ id: string; index: number }` |
| `show.sequence.done` | `{ id: string; cancelled: boolean }` |
| `show.sequence.cancel` | `{ id: string }` |
| `show.feature.set` | `{ message: ChatMessage }` |
| `show.feature.clear` | `{}` |

## Module events
Modules publish under `module.<moduleId>.<action>` only, and only types listed in their manifest `publishes`.

## WebSocket control ops (client → hub)
```jsonc
{ "op": "subscribe",   "topics": ["chat.", "show."] }   // prefix match
{ "op": "unsubscribe", "topics": ["chat."] }
{ "op": "publish",     "event": { "type": "...", "payload": { } } } // hub fills id/ts/source
{ "op": "history",     "topic": "chat.message", "limit": 50 }
```
Hub → client: envelopes, plus `{ "op": "error", "code": string, "message": string }`.
