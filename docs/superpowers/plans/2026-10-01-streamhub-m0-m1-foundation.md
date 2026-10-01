# streamhub M0+M1 (Foundation: bus, OBS, multistream, dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable streamhub that controls OBS (scenes, start/stop for every multistream destination) from a local web dashboard, built on the typed event bus that later chat connectors, the relay and modules will plug into.

**Architecture:** A pnpm/TypeScript monorepo. `packages/shared` holds the event contract (zod schemas + types). `apps/hub` is a Node process with an in-process bus (keeps the latest state events and a chat history buffer), a WebSocket API at `ws://127.0.0.1:4747/ws`, and an OBS bridge using obs-websocket v5. `packages/overlay-sdk` is the browser client for the bus. `apps/dashboard` is a React + Vite control panel that uses the SDK. Multistreaming is done by OBS + the obs-multi-rtmp plugin with "Sync start/stop with OBS"; the hub only starts and stops the main output.

**Tech Stack:** Node 20+, pnpm workspaces, TypeScript (strict, ESM), Fastify 5 + @fastify/static, `ws` 8, `obs-websocket-js` 5, zod, `ulid`, React 19 + Vite, Vitest, @testing-library/react + jsdom, ESLint (typescript-eslint) + Prettier, tsx.

**Spec:** `docs/superpowers/specs/2026-10-01-streamhub-base-design.md`. Read it, plus `CLAUDE.md`, `ARCHITECTURE.md` and `EVENTS.md` at the repo root.

**Later plans (not this one):** M2 Twitch + YouTube chat (after connector spikes), M3 relay + Kick, M4 module host + settings.

All paths below are relative to the repo root: `Vanpelt streaming studio/`.

## Global Constraints

- Node **20+**, pnpm workspaces, TypeScript `strict`, ESM (`"type": "module"`) everywhere.
- The hub binds **127.0.0.1 only**; default port **4747** (`HUB_PORT`). Vite dev server binds 127.0.0.1 too.
- **Never encode or send video.** OBS + obs-multi-rtmp do all video; the hub only calls obs-websocket.
- Chat platforms in v0: `'twitch' | 'youtube' | 'kick'` (no `'x'`; X is a video destination only).
- Event names are `domain.action`. Every event type is added to `packages/shared` (type + zod schema) before use, and `EVENTS.md` is updated in the same commit.
- Treat all event text (chat, scene names) as untrusted: React text nodes only, never `dangerouslySetInnerHTML` / `innerHTML`.
- Never log secrets (`OBS_WS_PASSWORD`, any token).
- Anything that connects out (OBS bridge, later connectors) fails soft: it emits a status event and retries with exponential backoff from **1 s to a 60 s cap, with jitter**.
- Definition of done per task: `pnpm test`, `pnpm typecheck` and `pnpm lint` pass, and the disconnected case is handled.
- Imports between workspace packages use package names (`@streamhub/shared`), never relative paths across packages. Modules/overlays never import hub code.

## Review Focus

1. **OBS not running, or wrong obs-websocket password, when the hub starts.** The hub must stay up, report `obs.connection {connected:false, detail}`, and keep retrying with growing delays. Pinned in Task 5 (`retries with backoff when OBS is down`, `reports auth failure detail and keeps retrying`).
2. **Accidental or repeated go-live / stop clicks.** One click must never start or stop the stream; OBS rejecting a duplicate `StartStream` must not crash anything. Pinned in Task 6 (`requires a second click to confirm`) and Task 5 (`survives OBS rejecting a command`).
3. **Dashboard reload (or a second dashboard tab) in the middle of a show.** It must immediately show the true current scene, OBS state and stream uptime. Pinned in Task 2 (`retains latest state per key, ordered`), Task 3 (`sends retained state on subscribe`) and Task 6 (`later scene change wins over retained list`).
4. **Malformed or hostile WebSocket input:** non-JSON, unknown ops, oversized frames, or a random website in the user's browser connecting to `ws://127.0.0.1:4747` (Origin check). Must answer with an error op (connection kept) or refuse/close, never crash. Pinned in Task 3.
5. **Scene names with spaces, emoji, quotes or non-Latin text.** They must round-trip verbatim from OBS to dashboard to the OBS command. Pinned in Task 5 (`passes scene names verbatim`) and Task 6 (reducer test with `🎬 "Main" Cam`).

---

### Task 1: Workspace skeleton + shared event contract

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.env.example`, `README.md`
- Modify: `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`, `src/envelope.ts`, `src/events.ts`, `src/topics.ts`, `src/protocol.ts`, `src/testing.ts`
- Test: `packages/shared/src/events.test.ts`, `packages/shared/src/topics.test.ts`
- Modify: `EVENTS.md`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `@streamhub/shared`):
  - `type Envelope<T extends string = string, P = unknown> = { id: string; type: T; ts: number; source: string; payload: P }`
  - `PlatformSchema`, `type Platform = 'twitch' | 'youtube' | 'kick'`
  - `ChatMessageSchema`, `type ChatMessage`, `type ConnectorStatus`, `type StreamState = 'starting' | 'live' | 'stopping' | 'stopped'`
  - `EventSchemas` (record of type → zod schema), `type KnownEventType`, `type EventPayload<T extends KnownEventType>`
  - `validatePayload(type: string, payload: unknown): { ok: true; payload: unknown } | { ok: false; error: string }`
  - `topicMatches(topics: Iterable<string>, type: string): boolean`: `'*'` matches all, a topic ending in `.` is a prefix, anything else is an exact type
  - `ClientOpSchema`, `type ClientOp`, `type ErrorCode = 'bad_json' | 'bad_op' | 'bad_payload' | 'forbidden'`, `type ServerMessage`
  - `@streamhub/shared/testing`: `chatMessage(overrides?: Partial<ChatMessage>): ChatMessage`

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "streamhub",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "pnpm --filter @streamhub/hub --filter @streamhub/dashboard --parallel run dev",
    "build": "pnpm --filter @streamhub/dashboard run build",
    "start": "pnpm --filter @streamhub/hub run start",
    "test": "pnpm -r --if-present run test",
    "typecheck": "pnpm -r --if-present run typecheck",
    "lint": "eslint .",
    "format": "prettier --write ."
  }
}
```
(Set `packageManager` to the output of `pnpm --version` on your machine.)

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/*
  - packages/*
  - modules/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  }
}
```

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
```

`.prettierrc.json`:
```json
{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

`.prettierignore`:
```
dist
pnpm-lock.yaml
*.md
```

`.env.example` (every key, empty value; blank means "use the default"):
```
# Hub port (default 4747)
HUB_PORT=
# OBS → Tools → WebSocket Server Settings (default ws://127.0.0.1:4455)
OBS_WS_URL=
OBS_WS_PASSWORD=
```

Append to `.gitignore`:
```
coverage/
*.log
```

`README.md`:
````markdown
# streamhub

Open-source, local-first control hub for live shows. It sits next to OBS: OBS encodes and streams (to several platforms via obs-multi-rtmp), and streamhub drives OBS and merges chat into one dashboard.

## Setup
1. Node 20+ and pnpm (`corepack enable`).
2. `pnpm install`
3. `cp .env.example .env` and fill `OBS_WS_PASSWORD` (OBS → Tools → WebSocket Server Settings → Enable, Show Connect Info).
4. Multistreaming: follow `docs/multistream.md`.

## Run
- Development: `pnpm dev`, then open http://127.0.0.1:5173
- Production-like: `pnpm build && pnpm start`, then open http://127.0.0.1:4747

## Docs
`CLAUDE.md` (rules), `ARCHITECTURE.md`, `EVENTS.md` (event contract), `docs/superpowers/specs/` (design), `docs/go-live.md` (pre-show checklist).
````

- [ ] **Step 2: Install root tooling**

Run:
```bash
pnpm add -Dw typescript eslint @eslint/js typescript-eslint eslint-config-prettier prettier vitest
```
Expected: `pnpm-lock.yaml` created, no errors.

- [ ] **Step 3: Create the shared package**

`packages/shared/package.json`:
```json
{
  "name": "@streamhub/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run: `pnpm --filter @streamhub/shared add zod ulid`

- [ ] **Step 4: Write the failing tests**

`packages/shared/src/topics.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { topicMatches } from './topics';

describe('topicMatches', () => {
  it('treats a trailing dot as a prefix', () => {
    expect(topicMatches(['obs.'], 'obs.scene.changed')).toBe(true);
    expect(topicMatches(['obs.'], 'chat.message')).toBe(false);
  });
  it('treats a topic without trailing dot as an exact type', () => {
    expect(topicMatches(['chat.message'], 'chat.message')).toBe(true);
    expect(topicMatches(['chat'], 'chat.message')).toBe(false);
  });
  it('matches everything with *', () => {
    expect(topicMatches(['*'], 'anything.at.all')).toBe(true);
  });
  it('is false for no topics', () => {
    expect(topicMatches([], 'chat.message')).toBe(false);
  });
});
```

`packages/shared/src/events.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { validatePayload } from './events';
import { ClientOpSchema } from './protocol';
import { chatMessage } from './testing';

describe('validatePayload', () => {
  it('accepts a valid chat message', () => {
    expect(validatePayload('chat.message', chatMessage())).toMatchObject({ ok: true });
  });
  it('rejects a platform that is not in v0', () => {
    const r = validatePayload('chat.message', chatMessage({ platform: 'x' as never }));
    expect(r.ok).toBe(false);
  });
  it('rejects unknown event types', () => {
    expect(validatePayload('nope.nothing', {})).toEqual({
      ok: false,
      error: 'unknown event type: nope.nothing',
    });
  });
  it('accepts any payload for module events', () => {
    expect(validatePayload('module.roast-o-meter.vote', { score: 3 })).toMatchObject({ ok: true });
  });
  it('rejects malformed module event names', () => {
    expect(validatePayload('module..vote', {}).ok).toBe(false);
  });
  it('rejects an empty scene name', () => {
    expect(validatePayload('obs.cmd.setScene', { scene: '' }).ok).toBe(false);
  });
  it('rejects extra keys on empty-payload commands', () => {
    expect(validatePayload('obs.cmd.startStream', {}).ok).toBe(true);
    expect(validatePayload('obs.cmd.startStream', { force: true }).ok).toBe(false);
  });
  it('describes the failing field', () => {
    const r = validatePayload('obs.scene.changed', { scene: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('scene');
  });
});

describe('ClientOpSchema', () => {
  it('defaults history limit to 50', () => {
    const op = ClientOpSchema.parse({ op: 'history', reqId: 'r1', topic: 'chat.message' });
    expect(op).toEqual({ op: 'history', reqId: 'r1', topic: 'chat.message', limit: 50 });
  });
  it('rejects history limits above 200', () => {
    expect(
      ClientOpSchema.safeParse({ op: 'history', reqId: 'r', topic: 'chat.message', limit: 500 })
        .success,
    ).toBe(false);
  });
  it('rejects unknown ops', () => {
    expect(ClientOpSchema.safeParse({ op: 'shutdown' }).success).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/shared test`
Expected: FAIL, modules `./topics`, `./events`, `./protocol` and `./testing` not found.

- [ ] **Step 6: Implement the shared package**

`packages/shared/src/topics.ts`:
```ts
/** `'*'` matches everything, `'obs.'` is a prefix, `'chat.message'` is an exact type. */
export function topicMatches(topics: Iterable<string>, type: string): boolean {
  for (const topic of topics) {
    if (topic === '*') return true;
    if (topic.endsWith('.') ? type.startsWith(topic) : type === topic) return true;
  }
  return false;
}
```

`packages/shared/src/envelope.ts`:
```ts
export type Envelope<T extends string = string, P = unknown> = {
  id: string; // ulid, sortable
  type: T; // 'domain.action'
  ts: number; // epoch ms, set by hub
  source: string; // 'hub' | 'obs' | 'connector:<platform>' | 'dashboard' | 'module:<id>'
  payload: P;
};
```

`packages/shared/src/events.ts`:
```ts
import { z } from 'zod';

export const PlatformSchema = z.enum(['twitch', 'youtube', 'kick']);
export type Platform = z.infer<typeof PlatformSchema>;

export const ChatAuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  color: z.string().optional(),
  roles: z.array(z.enum(['owner', 'moderator', 'vip', 'subscriber', 'member'])),
});

export const ChatFragmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('emote'), name: z.string(), url: z.string() }),
  z.object({ kind: z.literal('mention'), name: z.string() }),
  z.object({ kind: z.literal('link'), url: z.string() }),
]);

export const ChatMessageSchema = z.object({
  id: z.string(), // `${platform}:${platformMessageId}`
  platform: PlatformSchema,
  channel: z.string(),
  author: ChatAuthorSchema,
  text: z.string(),
  fragments: z.array(ChatFragmentSchema),
  sentAt: z.number(),
  raw: z.unknown().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ConnectorStatusSchema = z.enum(['disconnected', 'connecting', 'live', 'offline', 'error']);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const StreamStateSchema = z.enum(['starting', 'live', 'stopping', 'stopped']);
export type StreamState = z.infer<typeof StreamStateSchema>;

const Empty = z.object({}).strict();
const Connection = z.object({ connected: z.boolean(), detail: z.string().optional() });

export const EventSchemas = {
  'chat.message': ChatMessageSchema,
  'chat.deleted': z.object({ id: z.string() }),
  'platform.status': z.object({
    platform: PlatformSchema,
    status: ConnectorStatusSchema,
    detail: z.string().optional(),
  }),
  'relay.connection': Connection,
  'obs.connection': Connection,
  'obs.scene.changed': z.object({ scene: z.string() }),
  'obs.scenes.list': z.object({ scenes: z.array(z.string()), current: z.string() }),
  'obs.stream.state': z.object({ state: StreamStateSchema, startedAt: z.number().optional() }),
  'obs.cmd.setScene': z.object({ scene: z.string().min(1) }),
  'obs.cmd.startStream': Empty,
  'obs.cmd.stopStream': Empty,
  'obs.cmd.setSourceVisible': z.object({
    scene: z.string().min(1),
    source: z.string().min(1),
    visible: z.boolean(),
  }),
  'show.feature.set': z.object({ message: ChatMessageSchema }),
  'show.feature.clear': Empty,
} as const;

export type KnownEventType = keyof typeof EventSchemas;
export type EventPayload<T extends KnownEventType> = z.infer<(typeof EventSchemas)[T]>;

const MODULE_EVENT = /^module\.[a-z0-9-]+\.[a-zA-Z0-9_.-]+$/;

export function isKnownEventType(type: string): type is KnownEventType {
  return Object.hasOwn(EventSchemas, type);
}

export function validatePayload(
  type: string,
  payload: unknown,
): { ok: true; payload: unknown } | { ok: false; error: string } {
  if (isKnownEventType(type)) {
    const result = EventSchemas[type].safeParse(payload);
    if (result.success) return { ok: true, payload: result.data };
    const error = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error };
  }
  if (MODULE_EVENT.test(type)) return { ok: true, payload };
  return { ok: false, error: `unknown event type: ${type}` };
}
```

`packages/shared/src/protocol.ts`:
```ts
import { z } from 'zod';
import type { Envelope } from './envelope';

const Topics = z.array(z.string().min(1)).max(50);

export const ClientOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), topics: Topics }),
  z.object({ op: z.literal('unsubscribe'), topics: Topics }),
  z.object({
    op: z.literal('publish'),
    event: z.object({ type: z.string().min(1), payload: z.unknown() }),
  }),
  z.object({
    op: z.literal('history'),
    reqId: z.string().min(1),
    topic: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
  }),
]);
export type ClientOp = z.input<typeof ClientOpSchema>;

export type ErrorCode = 'bad_json' | 'bad_op' | 'bad_payload' | 'forbidden';

export type ServerMessage =
  | Envelope
  | { op: 'error'; code: ErrorCode; message: string }
  | { op: 'history-result'; reqId: string; events: Envelope[] };
```

`packages/shared/src/testing.ts`:
```ts
import type { ChatMessage } from './events';

export function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'twitch:1',
    platform: 'twitch',
    channel: 'yatf',
    author: { id: 'u1', name: 'viewer', roles: [] },
    text: 'hello',
    fragments: [{ kind: 'text', text: 'hello' }],
    sentAt: 1_700_000_000_000,
    ...overrides,
  };
}
```

`packages/shared/src/index.ts`:
```ts
export * from './envelope';
export * from './events';
export * from './protocol';
export * from './topics';
```

- [ ] **Step 7: Run tests, typecheck and lint**

Run: `pnpm --filter @streamhub/shared test && pnpm typecheck && pnpm lint`
Expected: all tests PASS (15), no type or lint errors.

- [ ] **Step 8: Update `EVENTS.md` to match the contract**

Make these edits:
1. Under the `type Platform = 'twitch' | 'youtube' | 'kick';` line (unchanged), add: `> X is a video destination only in v0; X chat is deferred (see docs/connectors/x.md).`
2. In the **OBS** table, keep all rows. Add a row to the **Chat** table: `| \`relay.connection\` | \`{ connected: boolean; detail?: string }\` |`.
3. Replace the **Show** table with only `show.feature.set` and `show.feature.clear`, followed by: `Transition and sequence events (\`show.transition.*\`, \`show.sequence.*\`) return with their modules after the base; they are not in packages/shared yet.`
4. Replace the **WebSocket control ops** section with:
````markdown
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

**Retained state:** on `subscribe`, the hub immediately sends the latest `obs.connection`, `obs.scenes.list`, `obs.scene.changed`, `obs.stream.state`, `relay.connection` and `platform.status` (one per platform) that match the new topics, oldest first. A reloaded dashboard is correct at once.

**Limits:** frames over 64 KB close the connection (code 1009). Dashboard clients may publish only `obs.cmd.*` and `show.*`.
````

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: workspace skeleton and shared event contract"
```

---

### Task 2: Hub core: config, backoff, event bus

**Files:**
- Create: `apps/hub/package.json`, `apps/hub/tsconfig.json`
- Create: `apps/hub/src/config.ts`, `apps/hub/src/util/backoff.ts`, `apps/hub/src/bus/bus.ts`
- Test: `apps/hub/src/config.test.ts`, `apps/hub/src/util/backoff.test.ts`, `apps/hub/src/bus/bus.test.ts`

**Interfaces:**
- Consumes: `validatePayload`, `topicMatches`, `Envelope` from `@streamhub/shared`.
- Produces:
  - `loadConfig(env?: Record<string, string | undefined>): HubConfig` where `HubConfig = { host: '127.0.0.1'; port: number; obsUrl: string; obsPassword: string; dev: boolean }`
  - `backoffDelay(attempt: number, rand?: () => number, baseMs?: number, maxMs?: number): number`
  - `class Bus { constructor(now?: () => number); publish(input: PublishInput): PublishResult; subscribe(topics: string[], handler: (e: Envelope) => void): () => void; retainedFor(topics: string[]): Envelope[]; history(type: string, limit: number): Envelope[] }`
  - `type PublishInput = { type: string; payload: unknown; source: string }`
  - `type PublishResult = { ok: true; event: Envelope } | { ok: false; error: string }`

- [ ] **Step 1: Create the hub package**

`apps/hub/package.json`:
```json
{
  "name": "@streamhub/hub",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "cross-env NODE_ENV=production tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/hub/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

Run:
```bash
pnpm --filter @streamhub/hub add @streamhub/shared@workspace:* zod ulid dotenv fastify @fastify/static ws obs-websocket-js
pnpm --filter @streamhub/hub add -D tsx cross-env @types/node @types/ws vitest
```

- [ ] **Step 2: Write the failing tests**

`apps/hub/src/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses defaults for missing or blank values', () => {
    expect(loadConfig({ HUB_PORT: '', OBS_WS_URL: '' })).toEqual({
      host: '127.0.0.1',
      port: 4747,
      obsUrl: 'ws://127.0.0.1:4455',
      obsPassword: '',
      dev: true,
    });
  });
  it('reads overrides', () => {
    const cfg = loadConfig({ HUB_PORT: '5000', OBS_WS_PASSWORD: 's3cret', NODE_ENV: 'production' });
    expect(cfg.port).toBe(5000);
    expect(cfg.obsPassword).toBe('s3cret');
    expect(cfg.dev).toBe(false);
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ HUB_PORT: '99999' })).toThrow();
  });
});
```

`apps/hub/src/util/backoff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

describe('backoffDelay', () => {
  it('starts around 1s', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(0, () => 0)).toBe(500);
  });
  it('doubles per attempt', () => {
    expect(backoffDelay(3, () => 1)).toBe(8000);
  });
  it('caps at 60s', () => {
    expect(backoffDelay(10, () => 1)).toBe(60_000);
    expect(backoffDelay(10, () => 0)).toBe(30_000);
    expect(backoffDelay(1000, () => 1)).toBe(60_000);
  });
});
```

`apps/hub/src/bus/bus.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { chatMessage } from '@streamhub/shared/testing';
import { Bus } from './bus';

const scene = (name: string) => ({ type: 'obs.scene.changed', payload: { scene: name }, source: 'obs' });

describe('Bus', () => {
  it('publishes a valid event as an envelope', () => {
    const bus = new Bus(() => 1234);
    const r = bus.publish(scene('Main'));
    expect(r).toMatchObject({
      ok: true,
      event: { type: 'obs.scene.changed', ts: 1234, source: 'obs', payload: { scene: 'Main' } },
    });
    if (r.ok) expect(r.event.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('rejects invalid payloads without notifying subscribers', () => {
    const bus = new Bus();
    const handler = vi.fn();
    bus.subscribe(['*'], handler);
    const r = bus.publish({ type: 'obs.scene.changed', payload: { scene: 1 }, source: 'obs' });
    expect(r.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers by topic and stops after unsubscribe', () => {
    const bus = new Bus();
    const obs = vi.fn();
    const chat = vi.fn();
    const off = bus.subscribe(['obs.'], obs);
    bus.subscribe(['chat.message'], chat);
    bus.publish(scene('A'));
    bus.publish({ type: 'chat.message', payload: chatMessage(), source: 'connector:twitch' });
    expect(obs).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    off();
    bus.publish(scene('B'));
    expect(obs).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when one handler throws', () => {
    const bus = new Bus();
    const good = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.subscribe(['*'], () => {
      throw new Error('boom');
    });
    bus.subscribe(['*'], good);
    bus.publish(scene('A'));
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('keeps the last 200 chat messages', () => {
    const bus = new Bus();
    for (let i = 0; i < 205; i++) {
      bus.publish({ type: 'chat.message', payload: chatMessage({ id: `twitch:${i}` }), source: 't' });
    }
    const all = bus.history('chat.message', 500);
    expect(all).toHaveLength(200);
    expect((all[0]!.payload as { id: string }).id).toBe('twitch:5');
    const last = bus.history('chat.message', 2);
    expect(last.map((e) => (e.payload as { id: string }).id)).toEqual(['twitch:203', 'twitch:204']);
    expect(bus.history('obs.scene.changed', 10)).toEqual([]);
  });

  it('retains latest state per key, ordered', () => {
    const bus = new Bus();
    bus.publish({ type: 'obs.scenes.list', payload: { scenes: ['A', 'B'], current: 'A' }, source: 'obs' });
    bus.publish(scene('B'));
    bus.publish(scene('C'));
    bus.publish({ type: 'platform.status', payload: { platform: 'twitch', status: 'live' }, source: 't' });
    bus.publish({ type: 'platform.status', payload: { platform: 'kick', status: 'error' }, source: 'k' });
    bus.publish({ type: 'chat.message', payload: chatMessage(), source: 't' });

    const obs = bus.retainedFor(['obs.']);
    expect(obs.map((e) => e.type)).toEqual(['obs.scenes.list', 'obs.scene.changed']);
    expect(obs[1]!.payload).toEqual({ scene: 'C' });

    const platforms = bus.retainedFor(['platform.status']);
    expect(platforms.map((e) => (e.payload as { platform: string }).platform)).toEqual([
      'twitch',
      'kick',
    ]);
    expect(bus.retainedFor(['chat.'])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub test`
Expected: FAIL, modules `./config`, `./backoff` and `./bus` not found.

- [ ] **Step 4: Implement**

`apps/hub/src/config.ts`:
```ts
import { z } from 'zod';

const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);

const EnvSchema = z.object({
  HUB_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(4747)),
  OBS_WS_URL: z.preprocess(blankToUndefined, z.string().default('ws://127.0.0.1:4455')),
  OBS_WS_PASSWORD: z.preprocess(blankToUndefined, z.string().default('')),
  NODE_ENV: z.preprocess(blankToUndefined, z.string().default('development')),
});

export type HubConfig = {
  host: '127.0.0.1';
  port: number;
  obsUrl: string;
  obsPassword: string;
  dev: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const e = EnvSchema.parse(env);
  return {
    host: '127.0.0.1',
    port: e.HUB_PORT,
    obsUrl: e.OBS_WS_URL,
    obsPassword: e.OBS_WS_PASSWORD,
    dev: e.NODE_ENV !== 'production',
  };
}
```

`apps/hub/src/util/backoff.ts`:
```ts
/** Exponential backoff with equal jitter: attempt 0 → 0.5–1 s, capped at 30–60 s. */
export function backoffDelay(
  attempt: number,
  rand: () => number = Math.random,
  baseMs = 1000,
  maxMs = 60_000,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}
```

`apps/hub/src/bus/bus.ts`:
```ts
import { monotonicFactory } from 'ulid';
import { topicMatches, validatePayload, type Envelope } from '@streamhub/shared';

export type PublishInput = { type: string; payload: unknown; source: string };
export type PublishResult = { ok: true; event: Envelope } | { ok: false; error: string };
type Handler = (e: Envelope) => void;

const HISTORY_LIMITS: Record<string, number> = { 'chat.message': 200 };

const RETAINED_TYPES = new Set([
  'obs.connection',
  'obs.scenes.list',
  'obs.scene.changed',
  'obs.stream.state',
  'relay.connection',
]);

function retainKey(e: Envelope): string | null {
  if (RETAINED_TYPES.has(e.type)) return e.type;
  if (e.type === 'platform.status') return `platform.status:${(e.payload as { platform: string }).platform}`;
  return null;
}

export class Bus {
  private readonly subs = new Set<{ topics: string[]; handler: Handler }>();
  private readonly retained = new Map<string, Envelope>();
  private readonly histories = new Map<string, Envelope[]>();
  private readonly nextId = monotonicFactory();

  constructor(private readonly now: () => number = Date.now) {}

  publish(input: PublishInput): PublishResult {
    const valid = validatePayload(input.type, input.payload);
    if (!valid.ok) return valid;
    const ts = this.now();
    const event: Envelope = {
      id: this.nextId(ts),
      type: input.type,
      ts,
      source: input.source,
      payload: valid.payload,
    };

    const key = retainKey(event);
    if (key) this.retained.set(key, event);

    const limit = HISTORY_LIMITS[event.type];
    if (limit) {
      const list = this.histories.get(event.type) ?? [];
      list.push(event);
      if (list.length > limit) list.shift();
      this.histories.set(event.type, list);
    }

    for (const sub of [...this.subs]) {
      if (!topicMatches(sub.topics, event.type)) continue;
      try {
        sub.handler(event);
      } catch (err) {
        console.error(`[bus] handler for ${event.type} threw`, err);
      }
    }
    return { ok: true, event };
  }

  subscribe(topics: string[], handler: Handler): () => void {
    const sub = { topics, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  /** Latest state events matching `topics`, oldest first. */
  retainedFor(topics: string[]): Envelope[] {
    return [...this.retained.values()]
      .filter((e) => topicMatches(topics, e.type))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  history(type: string, limit: number): Envelope[] {
    return (this.histories.get(type) ?? []).slice(-limit);
  }
}
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @streamhub/hub test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(hub): config, backoff and event bus with retained state and chat history"
```

---

### Task 3: Hub WebSocket API + HTTP server

**Files:**
- Create: `apps/hub/src/ws/server.ts`, `apps/hub/src/server.ts`
- Test: `apps/hub/src/ws/server.test.ts`

**Interfaces:**
- Consumes: `Bus` (Task 2), `ClientOpSchema`, `ServerMessage`, `ErrorCode`, `topicMatches` from shared.
- Produces:
  - `attachWebSocket(server: http.Server, opts: { bus: Bus; allowedOrigins: string[] }): WebSocketServer`
  - `isOriginAllowed(origin: string | undefined, allowed: string[]): boolean`
  - `DASHBOARD_PUBLISHABLE: string[]` (`['obs.cmd.', 'show.']`), `MAX_MESSAGE_BYTES = 65536`
  - `allowedOrigins(port: number, dev: boolean): string[]`
  - `createServer(opts: { bus: Bus; port: number; dev: boolean; dashboardDir: string; logger?: boolean }): Promise<FastifyInstance>`

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/ws/server.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@streamhub/shared';
import { chatMessage } from '@streamhub/shared/testing';
import { Bus } from '../bus/bus';
import { attachWebSocket, MAX_MESSAGE_BYTES } from './server';

const ORIGIN = 'http://127.0.0.1:4747';

type TestClient = {
  ws: WebSocket;
  send(msg: unknown): void;
  next(): Promise<ServerMessage>;
};

let bus: Bus;
let http: Server;
let port: number;
const clients: WebSocket[] = [];

beforeEach(async () => {
  bus = new Bus();
  http = createServer();
  attachWebSocket(http, { bus, allowedOrigins: [ORIGIN] });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as AddressInfo).port;
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.terminate());
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
});

function open(origin?: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    clients.push(ws);
    const inbox: ServerMessage[] = [];
    const waiters: Array<(m: ServerMessage) => void> = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
        next: () =>
          new Promise((r) => {
            const m = inbox.shift();
            if (m) r(m);
            else waiters.push(r);
          }),
      }),
    );
  });
}

/** Round-trips a history op so every earlier op has been processed. */
async function sync(c: TestClient) {
  c.send({ op: 'history', reqId: 'sync', topic: 'none', limit: 1 });
  expect(await c.next()).toMatchObject({ op: 'history-result', reqId: 'sync' });
}

describe('origin check', () => {
  it('accepts the hub origin and non-browser clients', async () => {
    await expect(open(ORIGIN)).resolves.toBeDefined();
    await expect(open()).resolves.toBeDefined();
  });
  it('rejects other websites', async () => {
    await expect(open('https://evil.example')).rejects.toThrow('HTTP 403');
  });
  it('rejects the null origin', async () => {
    await expect(open('null')).rejects.toThrow('HTTP 403');
  });
});

describe('ops', () => {
  it('delivers only subscribed topics', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'subscribe', topics: ['obs.'] });
    await sync(c);
    bus.publish({ type: 'platform.status', payload: { platform: 'twitch', status: 'live' }, source: 't' });
    bus.publish({ type: 'obs.scene.changed', payload: { scene: 'Main' }, source: 'obs' });
    expect(await c.next()).toMatchObject({ type: 'obs.scene.changed', payload: { scene: 'Main' } });
  });

  it('sends retained state on subscribe', async () => {
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    const c = await open(ORIGIN);
    c.send({ op: 'subscribe', topics: ['obs.'] });
    expect(await c.next()).toMatchObject({ type: 'obs.connection', payload: { connected: true } });
  });

  it('stops delivery after unsubscribe', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'subscribe', topics: ['obs.'] });
    c.send({ op: 'unsubscribe', topics: ['obs.'] });
    await sync(c);
    bus.publish({ type: 'obs.scene.changed', payload: { scene: 'Main' }, source: 'obs' });
    await sync(c); // would receive the scene change first if still subscribed
  });

  it('lets dashboards publish commands, stamped with their source', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['obs.cmd.'], (e) => seen.push(e));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'obs.cmd.setScene', payload: { scene: 'Main' } } });
    await sync(c);
    expect(seen).toMatchObject([{ type: 'obs.cmd.setScene', source: 'dashboard' }]);
  });

  it('forbids publishing hub-owned events', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'chat.message', payload: chatMessage() } });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'forbidden' });
  });

  it('reports invalid payloads', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'obs.cmd.setScene', payload: { scene: '' } } });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'bad_payload' });
  });

  it('survives garbage and unknown ops', async () => {
    const c = await open(ORIGIN);
    c.send('not json {');
    expect(await c.next()).toMatchObject({ op: 'error', code: 'bad_json' });
    c.send({ op: 'shutdown' });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'bad_op' });
    await sync(c);
  });

  it('returns chat history', async () => {
    for (let i = 0; i < 3; i++) {
      bus.publish({ type: 'chat.message', payload: chatMessage({ id: `twitch:${i}` }), source: 't' });
    }
    const c = await open(ORIGIN);
    c.send({ op: 'history', reqId: 'h1', topic: 'chat.message', limit: 2 });
    const res = await c.next();
    expect(res).toMatchObject({ op: 'history-result', reqId: 'h1' });
    if ('op' in res && res.op === 'history-result') expect(res.events).toHaveLength(2);
  });

  it('closes the connection on oversized frames', async () => {
    const c = await open(ORIGIN);
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    c.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub test -- src/ws`
Expected: FAIL, module `./server` not found.

- [ ] **Step 3: Implement the WebSocket API**

`apps/hub/src/ws/server.ts`:
```ts
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientOpSchema,
  topicMatches,
  type ErrorCode,
  type ServerMessage,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';

/** Event prefixes a dashboard client may publish. Modules get their own rules in M4. */
export const DASHBOARD_PUBLISHABLE = ['obs.cmd.', 'show.'];
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type WsOptions = { bus: Bus; allowedOrigins: string[] };

/** Browsers always send Origin; a missing Origin means a local non-browser client. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

export function attachWebSocket(server: Server, opts: WsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, opts.allowedOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, opts.bus));
  });
  return wss;
}

function handleClient(ws: WebSocket, bus: Bus) {
  const topics = new Set<string>();
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (code: ErrorCode, message: string) => send({ op: 'error', code, message });

  const unsubscribe = bus.subscribe(['*'], (event) => {
    if (topicMatches(topics, event.type)) send(event);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return fail('bad_op', 'binary frames are not supported');
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return fail('bad_json', 'message is not valid JSON');
    }
    const parsed = ClientOpSchema.safeParse(json);
    if (!parsed.success) return fail('bad_op', parsed.error.issues[0]?.message ?? 'invalid op');
    const op = parsed.data;

    switch (op.op) {
      case 'subscribe': {
        const fresh = op.topics.filter((t) => !topics.has(t));
        const before = [...topics];
        fresh.forEach((t) => topics.add(t));
        for (const event of bus.retainedFor(fresh)) {
          if (!topicMatches(before, event.type)) send(event);
        }
        return;
      }
      case 'unsubscribe':
        op.topics.forEach((t) => topics.delete(t));
        return;
      case 'publish': {
        const { type, payload } = op.event;
        if (!DASHBOARD_PUBLISHABLE.some((p) => type.startsWith(p))) {
          return fail('forbidden', `clients may not publish ${type}`);
        }
        const result = bus.publish({ type, payload, source: 'dashboard' });
        if (!result.ok) fail('bad_payload', result.error);
        return;
      }
      case 'history':
        send({ op: 'history-result', reqId: op.reqId, events: bus.history(op.topic, op.limit) });
        return;
    }
  });

  ws.on('close', unsubscribe);
  ws.on('error', () => ws.terminate());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub test -- src/ws`
Expected: PASS (12 tests).

- [ ] **Step 5: Implement the HTTP server**

`apps/hub/src/server.ts`:
```ts
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Bus } from './bus/bus';
import { attachWebSocket } from './ws/server';

export type ServerOptions = {
  bus: Bus;
  port: number;
  dev: boolean;
  dashboardDir: string;
  logger?: boolean;
};

export function allowedOrigins(port: number, dev: boolean): string[] {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (dev) origins.push('http://127.0.0.1:5173', 'http://localhost:5173'); // Vite dev server
  return origins;
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  app.get('/health', async () => ({ ok: true }));

  if (existsSync(opts.dashboardDir)) {
    await app.register(fastifyStatic, { root: opts.dashboardDir });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('Dashboard not built. Run `pnpm build`, or `pnpm dev` and open http://127.0.0.1:5173'),
    );
  }

  attachWebSocket(app.server, { bus: opts.bus, allowedOrigins: allowedOrigins(opts.port, opts.dev) });
  return app;
}
```

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @streamhub/hub test && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add -A
git commit -m "feat(hub): WebSocket API with origin check, permissions, retained state and history"
```

---

### Task 4: overlay-sdk (browser client for the bus)

**Files:**
- Create: `packages/overlay-sdk/package.json`, `packages/overlay-sdk/tsconfig.json`, `packages/overlay-sdk/src/index.ts`
- Test: `packages/overlay-sdk/src/index.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `ServerMessage`, `ErrorCode`, `topicMatches` from shared. It talks only to the hub's wire protocol (Task 3) and never imports hub code.
- Produces:
  - `connect(opts?: ConnectOptions): HubClient`
  - `type ConnectOptions = { url?: string; module?: string; token?: string; WebSocketImpl?: WebSocketCtor; reconnectBaseMs?: number; reconnectMaxMs?: number }`
  - `type HubStatus = 'connecting' | 'open' | 'closed'`
  - `interface HubClient { on(topic: string, handler: (e: Envelope) => void): () => void; publish(type: string, payload?: unknown): void; history(topic: string, limit?: number): Promise<Envelope[]>; onStatus(handler: (s: HubStatus) => void): () => void; onError(handler: (code: ErrorCode, message: string) => void): () => void; close(): void }`
  - `onStatus` calls the handler immediately with the current status.

- [ ] **Step 1: Create the package**

`packages/overlay-sdk/package.json`:
```json
{
  "name": "@streamhub/overlay-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/overlay-sdk/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"] },
  "include": ["src"]
}
```

Run:
```bash
pnpm --filter @streamhub/overlay-sdk add @streamhub/shared@workspace:*
pnpm --filter @streamhub/overlay-sdk add -D ws @types/ws vitest
```

- [ ] **Step 2: Write the failing tests**

`packages/overlay-sdk/src/index.test.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { connect, type HubClient, type WebSocketCtor } from './index';

const WS = WebSocket as unknown as WebSocketCtor;

let wss: WebSocketServer;
let url: string;
let sockets: ServerSocket[];
let received: Array<Record<string, unknown>>;
let requestUrls: string[];
let client: HubClient | undefined;

beforeEach(async () => {
  sockets = [];
  received = [];
  requestUrls = [];
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.on('connection', (socket, req) => {
    sockets.push(socket);
    requestUrls.push(req.url ?? '');
    socket.on('message', (d) => received.push(JSON.parse(d.toString())));
  });
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await new Promise((r) => wss.close(r));
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

const envelope = (type: string, payload: unknown = {}) =>
  JSON.stringify({ id: '01', type, ts: 1, source: 'hub', payload });

describe('connect', () => {
  it('subscribes on open and routes matching events', async () => {
    client = connect({ url, WebSocketImpl: WS });
    const obs: string[] = [];
    const exact: string[] = [];
    client.on('obs.', (e) => obs.push(e.type));
    client.on('chat.message', (e) => exact.push(e.type));
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ op: 'subscribe', topics: ['obs.', 'chat.message'] });

    sockets[0]!.send(envelope('obs.scene.changed'));
    sockets[0]!.send(envelope('chat.deleted'));
    sockets[0]!.send(envelope('chat.message'));
    await until(() => exact.length === 1);
    expect(obs).toEqual(['obs.scene.changed']);
  });

  it('queues publishes until the socket opens', async () => {
    client = connect({ url, WebSocketImpl: WS });
    client.publish('obs.cmd.setScene', { scene: 'Main' });
    await until(() => received.length === 1);
    expect(received[0]).toEqual({
      op: 'publish',
      event: { type: 'obs.cmd.setScene', payload: { scene: 'Main' } },
    });
  });

  it('resolves history by request id', async () => {
    client = connect({ url, WebSocketImpl: WS });
    const result = client.history('chat.message', 5);
    await until(() => received.length === 1);
    const req = received[0] as { reqId: string; limit: number };
    expect(req.limit).toBe(5);
    sockets[0]!.send(
      JSON.stringify({ op: 'history-result', reqId: req.reqId, events: [{ id: 'a' }] }),
    );
    await expect(result).resolves.toEqual([{ id: 'a' }]);
  });

  it('reports error ops', async () => {
    client = connect({ url, WebSocketImpl: WS });
    const errors: string[] = [];
    client.onError((code) => errors.push(code));
    await until(() => sockets.length === 1);
    sockets[0]!.send(JSON.stringify({ op: 'error', code: 'forbidden', message: 'no' }));
    await until(() => errors.length === 1);
    expect(errors).toEqual(['forbidden']);
  });

  it('reconnects and resubscribes after the hub drops', async () => {
    client = connect({ url, WebSocketImpl: WS, reconnectBaseMs: 10, reconnectMaxMs: 20 });
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    client.on('obs.', () => {});
    await until(() => received.length === 1);
    sockets[0]!.close();
    await until(() => received.length === 2);
    expect(received[1]).toEqual({ op: 'subscribe', topics: ['obs.'] });
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
  });

  it('passes module identity in the URL', async () => {
    client = connect({ url, WebSocketImpl: WS, module: 'chat-overlay', token: 't0k' });
    await until(() => requestUrls.length === 1);
    expect(requestUrls[0]).toBe('/ws?module=chat-overlay&token=t0k');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/overlay-sdk test`
Expected: FAIL, module `./index` not found.

- [ ] **Step 4: Implement**

`packages/overlay-sdk/src/index.ts`:
```ts
import { topicMatches, type Envelope, type ErrorCode, type ServerMessage } from '@streamhub/shared';

export type HubStatus = 'connecting' | 'open' | 'closed';
export type WebSocketCtor = new (url: string) => WebSocket;

export type ConnectOptions = {
  /** Defaults to `ws(s)://<page host>/ws`. */
  url?: string;
  module?: string;
  token?: string;
  WebSocketImpl?: WebSocketCtor;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

export interface HubClient {
  on(topic: string, handler: (e: Envelope) => void): () => void;
  publish(type: string, payload?: unknown): void;
  history(topic: string, limit?: number): Promise<Envelope[]>;
  onStatus(handler: (s: HubStatus) => void): () => void;
  onError(handler: (code: ErrorCode, message: string) => void): () => void;
  close(): void;
}

const OPEN = 1;
const MAX_OUTBOX = 100;

function defaultUrl(): string {
  const loc = globalThis.location;
  if (!loc) throw new Error('connect(): pass `url` when not running in a browser');
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

export function connect(opts: ConnectOptions = {}): HubClient {
  const Impl = opts.WebSocketImpl ?? globalThis.WebSocket;
  const baseMs = opts.reconnectBaseMs ?? 1000;
  const maxMs = opts.reconnectMaxMs ?? 30_000;
  const url = new URL(opts.url ?? defaultUrl());
  if (opts.module) url.searchParams.set('module', opts.module);
  if (opts.token) url.searchParams.set('token', opts.token);

  const handlers = new Map<string, Set<(e: Envelope) => void>>();
  const statusHandlers = new Set<(s: HubStatus) => void>();
  const errorHandlers = new Set<(code: ErrorCode, message: string) => void>();
  const pending = new Map<string, { resolve: (e: Envelope[]) => void; reject: (err: Error) => void }>();
  const outbox: string[] = [];

  let ws: WebSocket | null = null;
  let status: HubStatus = 'connecting';
  let attempt = 0;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reqSeq = 0;

  const setStatus = (s: HubStatus) => {
    status = s;
    statusHandlers.forEach((h) => h(s));
  };

  /** Sends now if open; otherwise queues (publish/history only; subscriptions are replayed on open). */
  const send = (msg: object) => {
    const text = JSON.stringify(msg);
    if (ws?.readyState === OPEN) ws.send(text);
    else if (outbox.length < MAX_OUTBOX) outbox.push(text);
  };
  const sendIfOpen = (msg: object) => {
    if (ws?.readyState === OPEN) ws.send(JSON.stringify(msg));
  };

  const onMessage = (msg: ServerMessage) => {
    if ('op' in msg) {
      if (msg.op === 'error') errorHandlers.forEach((h) => h(msg.code, msg.message));
      if (msg.op === 'history-result') {
        pending.get(msg.reqId)?.resolve(msg.events);
        pending.delete(msg.reqId);
      }
      return;
    }
    for (const [topic, set] of handlers) {
      if (topicMatches([topic], msg.type)) set.forEach((h) => h(msg));
    }
  };

  const open = () => {
    setStatus('connecting');
    const sock = new Impl(url.toString());
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      setStatus('open');
      if (handlers.size) sock.send(JSON.stringify({ op: 'subscribe', topics: [...handlers.keys()] }));
      for (const text of outbox.splice(0)) sock.send(text);
    };
    sock.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setStatus('closed');
      pending.forEach((p) => p.reject(new Error('hub connection closed')));
      pending.clear();
      if (closed) return;
      const ceiling = Math.min(maxMs, baseMs * 2 ** attempt++);
      retry = setTimeout(open, ceiling / 2 + Math.random() * (ceiling / 2));
    };
  };

  open();

  return {
    on(topic, handler) {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        sendIfOpen({ op: 'subscribe', topics: [topic] });
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0 && handlers.get(topic) === set) {
          handlers.delete(topic);
          sendIfOpen({ op: 'unsubscribe', topics: [topic] });
        }
      };
    },
    publish(type, payload = {}) {
      send({ op: 'publish', event: { type, payload } });
    },
    history(topic, limit = 50) {
      const reqId = `h${++reqSeq}`;
      return new Promise<Envelope[]>((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        send({ op: 'history', reqId, topic, limit });
      });
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      handler(status);
      return () => statusHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    close() {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @streamhub/overlay-sdk test && pnpm typecheck && pnpm lint`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(overlay-sdk): bus client with topics, history, queued publish and auto-reconnect"
```

---

### Task 5: OBS bridge + hub entry point

**Files:**
- Create: `apps/hub/src/obs/bridge.ts`, `apps/hub/src/main.ts`
- Test: `apps/hub/src/obs/bridge.test.ts`

**Interfaces:**
- Consumes: `Bus` (Task 2), `backoffDelay` (Task 2), `createServer` (Task 3), `loadConfig` (Task 2), `EventPayload` from shared.
- Produces:
  - `interface ObsClient { connect(url: string, password?: string): Promise<unknown>; disconnect(): Promise<void>; call(requestType: string, requestData?: object): Promise<unknown>; on(event: string, listener: (data: never) => void): unknown }`
  - `type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }`
  - `class ObsBridge { constructor(opts: { bus: Bus; client: ObsClient; url: string; password: string; timer?: Timer; rand?: () => number; now?: () => number }); start(): void; stop(): Promise<void> }`
  - Publishes `obs.connection`, `obs.scenes.list` (scenes in OBS UI order, top first), `obs.scene.changed`, `obs.stream.state`, all with source `'obs'`. Handles `obs.cmd.*`.

obs-websocket v5 reference (verify against https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md before implementing):
- `GetSceneList` → `{ currentProgramSceneName: string; scenes: { sceneName: string; sceneIndex: number }[] }`. A higher `sceneIndex` is higher in the OBS scene list.
- `GetStreamStatus` → `{ outputActive: boolean; outputDuration: number /* ms */ }`
- `SetCurrentProgramScene { sceneName }`, `StartStream`, `StopStream`
- `GetSceneItemId { sceneName, sourceName }` → `{ sceneItemId }`; `SetSceneItemEnabled { sceneName, sceneItemId, sceneItemEnabled }`
- Events: `CurrentProgramSceneChanged { sceneName }`, `SceneListChanged { scenes }`, `StreamStateChanged { outputActive, outputState }`, and `ConnectionClosed` (an error object from obs-websocket-js).

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/obs/bridge.test.ts`:
```ts
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { ObsBridge, type ObsClient, type Timer } from './bridge';

class FakeObs extends EventEmitter implements ObsClient {
  connectResults: Array<Error | null> = [];
  calls: Array<[string, object | undefined]> = [];
  responses: Record<string, unknown> = {
    GetSceneList: {
      currentProgramSceneName: 'Main Cam',
      scenes: [
        { sceneName: 'Ending', sceneIndex: 0 },
        { sceneName: 'Main Cam', sceneIndex: 1 },
        { sceneName: 'Starting Soon', sceneIndex: 2 },
      ],
    },
    GetStreamStatus: { outputActive: false, outputDuration: 0 },
    GetSceneItemId: { sceneItemId: 7 },
  };
  failing = new Set<string>();

  async connect() {
    const next = this.connectResults.shift() ?? null;
    if (next) throw next;
  }
  async disconnect() {}
  async call(type: string, data?: object) {
    this.calls.push([type, data]);
    if (this.failing.has(type)) throw new Error(`${type} failed`);
    return this.responses[type] ?? {};
  }
}

class FakeTimer implements Timer {
  queue: Array<{ fn: () => void; ms: number }> = [];
  set(fn: () => void, ms: number) {
    const entry = { fn, ms };
    this.queue.push(entry);
    return entry;
  }
  clear(handle: unknown) {
    this.queue = this.queue.filter((e) => e !== handle);
  }
  runNext() {
    this.queue.shift()?.fn();
  }
}

const flush = () => new Promise((r) => setImmediate(r));

let bus: Bus;
let obs: FakeObs;
let timer: FakeTimer;
let events: Envelope[];
let bridge: ObsBridge;

beforeEach(() => {
  bus = new Bus();
  obs = new FakeObs();
  timer = new FakeTimer();
  events = [];
  bus.subscribe(['obs.'], (e) => {
    if (!e.type.startsWith('obs.cmd.')) events.push(e);
  });
  bridge = new ObsBridge({
    bus,
    client: obs,
    url: 'ws://127.0.0.1:4455',
    password: 'pw',
    timer,
    rand: () => 1,
    now: () => 100_000,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await bridge.stop();
});

const payloads = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);

describe('ObsBridge', () => {
  it('publishes connection, scenes in UI order and stream state on connect', async () => {
    bridge.start();
    await flush();
    expect(payloads('obs.connection')).toEqual([{ connected: true }]);
    expect(payloads('obs.scenes.list')).toEqual([
      { scenes: ['Starting Soon', 'Main Cam', 'Ending'], current: 'Main Cam' },
    ]);
    expect(payloads('obs.stream.state')).toEqual([{ state: 'stopped' }]);
  });

  it('reports an already-running stream with its start time', async () => {
    obs.responses.GetStreamStatus = { outputActive: true, outputDuration: 60_000 };
    bridge.start();
    await flush();
    expect(payloads('obs.stream.state')).toEqual([{ state: 'live', startedAt: 40_000 }]);
  });

  it('retries with backoff when OBS is down', async () => {
    obs.connectResults = [new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED')];
    bridge.start();
    await flush();
    expect(payloads('obs.connection')).toEqual([
      { connected: false, detail: 'connect ECONNREFUSED' },
    ]);
    expect(timer.queue.map((e) => e.ms)).toEqual([1000]);

    timer.runNext();
    await flush();
    expect(timer.queue.map((e) => e.ms)).toEqual([2000]);

    timer.runNext();
    await flush();
    expect(payloads('obs.connection').at(-1)).toEqual({ connected: true });
    expect(timer.queue).toEqual([]);
  });

  it('reports auth failure detail and keeps retrying', async () => {
    obs.connectResults = [new Error('Authentication failed.')];
    bridge.start();
    await flush();
    expect(payloads('obs.connection')).toEqual([
      { connected: false, detail: 'Authentication failed.' },
    ]);
    expect(timer.queue).toHaveLength(1);
  });

  it('reconnects once after OBS closes the connection', async () => {
    bridge.start();
    await flush();
    obs.emit('ConnectionClosed', new Error('socket closed'));
    obs.emit('ConnectionClosed', new Error('socket closed'));
    expect(payloads('obs.connection').at(-1)).toEqual({ connected: false, detail: 'socket closed' });
    expect(timer.queue).toHaveLength(1);
  });

  it('forwards OBS scene and stream events', async () => {
    bridge.start();
    await flush();
    obs.emit('CurrentProgramSceneChanged', { sceneName: 'Ending' });
    obs.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
    expect(payloads('obs.scene.changed')).toEqual([{ scene: 'Ending' }]);
    expect(payloads('obs.stream.state').at(-1)).toEqual({ state: 'live', startedAt: 100_000 });
  });

  it('refreshes the scene list when scenes change', async () => {
    bridge.start();
    await flush();
    obs.emit('SceneListChanged', { scenes: [] });
    await flush();
    expect(payloads('obs.scenes.list')).toHaveLength(2);
  });

  it('passes scene names verbatim', async () => {
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.setScene', payload: { scene: '🎬 "Main" Cam' }, source: 'dashboard' });
    await flush();
    expect(obs.calls).toContainEqual(['SetCurrentProgramScene', { sceneName: '🎬 "Main" Cam' }]);
  });

  it('starts and stops the stream', async () => {
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.startStream', payload: {}, source: 'dashboard' });
    bus.publish({ type: 'obs.cmd.stopStream', payload: {}, source: 'dashboard' });
    await flush();
    expect(obs.calls.map(([t]) => t)).toEqual(
      expect.arrayContaining(['StartStream', 'StopStream']),
    );
  });

  it('toggles source visibility by scene item id', async () => {
    bridge.start();
    await flush();
    bus.publish({
      type: 'obs.cmd.setSourceVisible',
      payload: { scene: 'Main Cam', source: 'Webcam', visible: false },
      source: 'dashboard',
    });
    await flush();
    expect(obs.calls).toContainEqual(['GetSceneItemId', { sceneName: 'Main Cam', sourceName: 'Webcam' }]);
    expect(obs.calls).toContainEqual([
      'SetSceneItemEnabled',
      { sceneName: 'Main Cam', sceneItemId: 7, sceneItemEnabled: false },
    ]);
  });

  it('ignores commands while disconnected', async () => {
    obs.connectResults = [new Error('down')];
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.startStream', payload: {}, source: 'dashboard' });
    await flush();
    expect(obs.calls.map(([t]) => t)).not.toContain('StartStream');
  });

  it('survives OBS rejecting a command', async () => {
    obs.failing.add('StartStream');
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.startStream', payload: {}, source: 'dashboard' });
    await flush();
    bus.publish({ type: 'obs.cmd.setScene', payload: { scene: 'Ending' }, source: 'dashboard' });
    await flush();
    expect(obs.calls).toContainEqual(['SetCurrentProgramScene', { sceneName: 'Ending' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub test -- src/obs`
Expected: FAIL, module `./bridge` not found.

- [ ] **Step 3: Implement the bridge**

`apps/hub/src/obs/bridge.ts`:
```ts
import type { Envelope, EventPayload, KnownEventType, StreamState } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import { backoffDelay } from '../util/backoff';

/** The subset of obs-websocket-js we use, so tests can fake it. */
export interface ObsClient {
  connect(url: string, password?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  call(requestType: string, requestData?: object): Promise<unknown>;
  on(event: string, listener: (data: never) => void): unknown;
}

export type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export type ObsBridgeOptions = {
  bus: Bus;
  client: ObsClient;
  url: string;
  password: string;
  timer?: Timer;
  rand?: () => number;
  now?: () => number;
};

type ObsScene = { sceneName: string; sceneIndex: number };

const OUTPUT_STATES: Record<string, StreamState> = {
  OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
  OBS_WEBSOCKET_OUTPUT_STARTED: 'live',
  OBS_WEBSOCKET_OUTPUT_RECONNECTING: 'live',
  OBS_WEBSOCKET_OUTPUT_RECONNECTED: 'live',
  OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
  OBS_WEBSOCKET_OUTPUT_STOPPED: 'stopped',
};

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class ObsBridge {
  private connected = false;
  private stopped = true;
  private attempt = 0;
  private retry: unknown = null;
  private streamStartedAt: number | undefined;
  private unsubscribeBus: (() => void) | null = null;
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: ObsBridgeOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    const { client } = opts;
    client.on('ConnectionClosed', (err: unknown) => this.onClosed(err));
    client.on('CurrentProgramSceneChanged', (d: { sceneName: string }) =>
      this.emit('obs.scene.changed', { scene: d.sceneName }),
    );
    client.on('SceneListChanged', () => {
      this.refreshScenes().catch((err) => console.warn(`[obs] scene refresh failed: ${describeError(err)}`));
    });
    client.on('StreamStateChanged', (d: { outputState: string }) => this.onStreamState(d.outputState));
  }

  start() {
    this.stopped = false;
    this.unsubscribeBus = this.opts.bus.subscribe(['obs.cmd.'], (e) => void this.handleCommand(e));
    void this.connect();
  }

  async stop() {
    this.stopped = true;
    this.unsubscribeBus?.();
    if (this.retry !== null) this.timer.clear(this.retry);
    this.retry = null;
    await this.opts.client.disconnect().catch(() => {});
  }

  private emit<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    this.opts.bus.publish({ type, payload, source: 'obs' });
  }

  private async connect() {
    if (this.stopped) return;
    try {
      await this.opts.client.connect(this.opts.url, this.opts.password || undefined);
      this.connected = true;
      this.attempt = 0;
      this.emit('obs.connection', { connected: true });
      await this.refreshScenes();
      await this.refreshStream();
    } catch (err) {
      this.connected = false;
      this.emit('obs.connection', { connected: false, detail: describeError(err) });
      this.scheduleReconnect();
    }
  }

  private onClosed(err: unknown) {
    if (!this.connected) return; // connect() failures are handled in connect()
    this.connected = false;
    this.emit('obs.connection', { connected: false, detail: describeError(err) });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.retry !== null) return;
    const delay = backoffDelay(this.attempt++, this.rand);
    this.retry = this.timer.set(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }

  private async refreshScenes() {
    const list = (await this.opts.client.call('GetSceneList')) as {
      currentProgramSceneName: string;
      scenes: ObsScene[];
    };
    const scenes = [...list.scenes]
      .sort((a, b) => b.sceneIndex - a.sceneIndex)
      .map((s) => s.sceneName);
    this.emit('obs.scenes.list', { scenes, current: list.currentProgramSceneName });
  }

  private async refreshStream() {
    const status = (await this.opts.client.call('GetStreamStatus')) as {
      outputActive: boolean;
      outputDuration: number;
    };
    if (status.outputActive) {
      this.streamStartedAt = this.now() - status.outputDuration;
      this.emit('obs.stream.state', { state: 'live', startedAt: this.streamStartedAt });
    } else {
      this.streamStartedAt = undefined;
      this.emit('obs.stream.state', { state: 'stopped' });
    }
  }

  private onStreamState(outputState: string) {
    const state = OUTPUT_STATES[outputState];
    if (!state) return;
    if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.streamStartedAt = this.now();
    if (state === 'stopped') this.streamStartedAt = undefined;
    this.emit(
      'obs.stream.state',
      state === 'live' ? { state, startedAt: this.streamStartedAt ?? this.now() } : { state },
    );
  }

  private async handleCommand(e: Envelope) {
    if (!this.connected) {
      console.warn(`[obs] ignoring ${e.type}: OBS is not connected`);
      return;
    }
    const { client } = this.opts;
    try {
      switch (e.type) {
        case 'obs.cmd.setScene': {
          const p = e.payload as EventPayload<'obs.cmd.setScene'>;
          await client.call('SetCurrentProgramScene', { sceneName: p.scene });
          break;
        }
        case 'obs.cmd.startStream':
          await client.call('StartStream');
          break;
        case 'obs.cmd.stopStream':
          await client.call('StopStream');
          break;
        case 'obs.cmd.setSourceVisible': {
          const p = e.payload as EventPayload<'obs.cmd.setSourceVisible'>;
          const { sceneItemId } = (await client.call('GetSceneItemId', {
            sceneName: p.scene,
            sourceName: p.source,
          })) as { sceneItemId: number };
          await client.call('SetSceneItemEnabled', {
            sceneName: p.scene,
            sceneItemId,
            sceneItemEnabled: p.visible,
          });
          break;
        }
      }
    } catch (err) {
      console.warn(`[obs] ${e.type} failed: ${describeError(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub test -- src/obs`
Expected: PASS (12 tests).

- [ ] **Step 5: Hub entry point**

`apps/hub/src/main.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import OBSWebSocket from 'obs-websocket-js';
import { Bus } from './bus/bus';
import { loadConfig } from './config';
import { ObsBridge, type ObsClient } from './obs/bridge';
import { createServer } from './server';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const cfg = loadConfig();

const bus = new Bus();
const app = await createServer({
  bus,
  port: cfg.port,
  dev: cfg.dev,
  dashboardDir: fileURLToPath(new URL('../../dashboard/dist', import.meta.url)),
});
const obs = new ObsBridge({
  bus,
  client: new OBSWebSocket() as unknown as ObsClient,
  url: cfg.obsUrl,
  password: cfg.obsPassword,
});

try {
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} is already in use. Set HUB_PORT in .env to another port.`);
    process.exit(1);
  }
  throw err;
}
obs.start();

const shutdown = async () => {
  await obs.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: Manual check (OBS not running)**

Run: `pnpm --filter @streamhub/hub dev`
Expected: Fastify logs `Server listening at http://127.0.0.1:4747`, and the process stays up. `curl -s http://127.0.0.1:4747/health` prints `{"ok":true}`. Stop with Ctrl-C.

OBS connectivity is checked end to end through the dashboard in Task 6.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add -A
git commit -m "feat(hub): OBS bridge with reconnect, scene/stream state and commands"
```

---

### Task 6: Dashboard (scenes, stream control, status)

**Files:**
- Create: `apps/dashboard/package.json`, `apps/dashboard/tsconfig.json`, `apps/dashboard/vite.config.ts`, `apps/dashboard/index.html`
- Create: `apps/dashboard/src/main.tsx`, `src/App.tsx`, `src/hub.ts`, `src/state.ts`, `src/useDashboardState.ts`, `src/styles.css`
- Create: `apps/dashboard/src/components/ScenePanel.tsx`, `StreamControls.tsx`, `StatusBar.tsx`
- Test: `apps/dashboard/src/state.test.ts`, `apps/dashboard/src/components/StreamControls.test.tsx`

**Interfaces:**
- Consumes: `connect`, `HubClient`, `HubStatus` from `@streamhub/overlay-sdk`; `Envelope`, `EventPayload`, `Platform`, `ConnectorStatus`, `StreamState` from `@streamhub/shared`. The hub serves `apps/dashboard/dist` (Task 3).
- Produces:
  - `type DashboardState = { hubConnected: boolean; obs: { connected: boolean; detail?: string }; scenes: string[]; currentScene: string | null; stream: { state: StreamState; startedAt?: number }; platforms: Partial<Record<Platform, { status: ConnectorStatus; detail?: string }>> }`
  - `reduce(state: DashboardState, action: Action): DashboardState`, `initialState`, `formatUptime(ms: number): string`
  - `type Action = { kind: 'hub'; connected: boolean } | { kind: 'event'; event: Envelope }`
  - M2 adds chat to this state and a `ChatPanel` in place of the placeholder.

- [ ] **Step 1: Create the package**

`apps/dashboard/package.json`:
```json
{
  "name": "@streamhub/dashboard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/dashboard/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src", "vite.config.ts"]
}
```

Run:
```bash
pnpm --filter @streamhub/dashboard add react react-dom @streamhub/overlay-sdk@workspace:* @streamhub/shared@workspace:*
pnpm --filter @streamhub/dashboard add -D vite @vitejs/plugin-react @types/react @types/react-dom vitest jsdom @testing-library/react @types/node
```

`apps/dashboard/vite.config.ts`:
```ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'HUB_');
  const hubPort = env.HUB_PORT || '4747';
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/ws': { target: `ws://127.0.0.1:${hubPort}`, ws: true } },
    },
    build: { outDir: 'dist' },
  };
});
```

`apps/dashboard/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>streamhub</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing tests**

`apps/dashboard/src/state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { formatUptime, initialState, reduce, type DashboardState } from './state';

let seq = 0;
const ev = (type: string, payload: unknown): Envelope => ({
  id: String(seq++).padStart(26, '0'),
  type,
  ts: 0,
  source: 'obs',
  payload,
});
const apply = (events: Envelope[], start: DashboardState = initialState) =>
  events.reduce((s, event) => reduce(s, { kind: 'event', event }), start);

describe('reduce', () => {
  it('tracks hub connection and resets on disconnect', () => {
    const live = apply([ev('obs.connection', { connected: true })], reduce(initialState, { kind: 'hub', connected: true }));
    expect(live.hubConnected).toBe(true);
    expect(live.obs.connected).toBe(true);
    const lost = reduce(live, { kind: 'hub', connected: false });
    expect(lost).toEqual(initialState);
  });

  it('later scene change wins over retained list', () => {
    const name = '🎬 "Main" Cam';
    const s = apply([
      ev('obs.scenes.list', { scenes: ['Starting', name], current: 'Starting' }),
      ev('obs.scene.changed', { scene: name }),
    ]);
    expect(s.scenes).toEqual(['Starting', name]);
    expect(s.currentScene).toBe(name);
  });

  it('keeps OBS detail when disconnected', () => {
    const s = apply([ev('obs.connection', { connected: false, detail: 'Authentication failed.' })]);
    expect(s.obs).toEqual({ connected: false, detail: 'Authentication failed.' });
  });

  it('tracks stream state and platform statuses', () => {
    const s = apply([
      ev('obs.stream.state', { state: 'live', startedAt: 5 }),
      ev('platform.status', { platform: 'kick', status: 'error', detail: 'relay unreachable' }),
    ]);
    expect(s.stream).toEqual({ state: 'live', startedAt: 5 });
    expect(s.platforms.kick).toEqual({ status: 'error', detail: 'relay unreachable' });
  });

  it('ignores unrelated events', () => {
    expect(apply([ev('show.feature.clear', {})])).toBe(initialState);
  });
});

describe('formatUptime', () => {
  it('formats h:mm:ss', () => {
    expect(formatUptime(0)).toBe('0:00:00');
    expect(formatUptime(3_723_000)).toBe('1:02:03');
    expect(formatUptime(-5)).toBe('0:00:00');
  });
});
```

`apps/dashboard/src/components/StreamControls.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamControls } from './StreamControls';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StreamControls', () => {
  it('requires a second click to confirm', () => {
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Click again to GO LIVE' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('stops only after confirmation while live', () => {
    const onStop = vi.fn();
    render(<StreamControls stream={{ state: 'live', startedAt: 0 }} disabled={false} onStart={vi.fn()} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop stream' }));
    fireEvent.click(screen.getByRole('button', { name: 'Click again to STOP stream' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('disarms after the confirm window', () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} confirmMs={1000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    act(() => vi.advanceTimersByTime(1001));
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('is disabled while OBS is unavailable or the stream is changing state', () => {
    const { rerender } = render(
      <StreamControls stream={{ state: 'stopped' }} disabled onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    rerender(<StreamControls stream={{ state: 'starting' }} disabled={false} onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/dashboard test`
Expected: FAIL, modules `./state` and `./StreamControls` not found.

- [ ] **Step 4: Implement state + StreamControls**

`apps/dashboard/src/state.ts`:
```ts
import type {
  ConnectorStatus,
  Envelope,
  EventPayload,
  Platform,
  StreamState,
} from '@streamhub/shared';

export type DashboardState = {
  hubConnected: boolean;
  obs: { connected: boolean; detail?: string };
  scenes: string[];
  currentScene: string | null;
  stream: { state: StreamState; startedAt?: number };
  platforms: Partial<Record<Platform, { status: ConnectorStatus; detail?: string }>>;
};

export type Action = { kind: 'hub'; connected: boolean } | { kind: 'event'; event: Envelope };

export const initialState: DashboardState = {
  hubConnected: false,
  obs: { connected: false },
  scenes: [],
  currentScene: null,
  stream: { state: 'stopped' },
  platforms: {},
};

export function reduce(state: DashboardState, action: Action): DashboardState {
  if (action.kind === 'hub') {
    // On reconnect the hub resends retained state, so start clean.
    return action.connected ? { ...state, hubConnected: true } : initialState;
  }
  const { type, payload } = action.event;
  switch (type) {
    case 'obs.connection':
      return { ...state, obs: payload as EventPayload<'obs.connection'> };
    case 'obs.scenes.list': {
      const p = payload as EventPayload<'obs.scenes.list'>;
      return { ...state, scenes: p.scenes, currentScene: p.current };
    }
    case 'obs.scene.changed':
      return { ...state, currentScene: (payload as EventPayload<'obs.scene.changed'>).scene };
    case 'obs.stream.state':
      return { ...state, stream: payload as EventPayload<'obs.stream.state'> };
    case 'platform.status': {
      const p = payload as EventPayload<'platform.status'>;
      return {
        ...state,
        platforms: { ...state.platforms, [p.platform]: { status: p.status, detail: p.detail } },
      };
    }
    default:
      return state;
  }
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
```

Note: the "resets on disconnect" test expects `reduce(live, {kind:'hub', connected:false})` to equal `initialState`, which this does.

`apps/dashboard/src/components/StreamControls.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { DashboardState } from '../state';

type Props = {
  stream: DashboardState['stream'];
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  confirmMs?: number;
};

export function StreamControls({ stream, disabled, onStart, onStop, confirmMs = 4000 }: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), confirmMs);
    return () => clearTimeout(t);
  }, [armed, confirmMs]);

  const live = stream.state === 'live' || stream.state === 'starting';
  const changing = stream.state === 'starting' || stream.state === 'stopping';
  const label = armed
    ? live
      ? 'Click again to STOP stream'
      : 'Click again to GO LIVE'
    : live
      ? 'Stop stream'
      : 'Start stream';

  const onClick = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    if (live) onStop();
    else onStart();
  };

  return (
    <div className="stream-controls">
      <button className={live ? 'danger' : 'primary'} disabled={disabled || changing} onClick={onClick}>
        {label}
      </button>
      <p className="hint">
        Other platforms (multi-rtmp targets) follow OBS only if “Sync start/stop with OBS” is ticked.
      </p>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/dashboard test`
Expected: PASS (10 tests).

- [ ] **Step 6: Implement the rest of the UI**

`apps/dashboard/src/hub.ts`:
```ts
import { connect } from '@streamhub/overlay-sdk';

export const hub = connect();
```

`apps/dashboard/src/useDashboardState.ts`:
```ts
import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { initialState, reduce, type DashboardState } from './state';

export function useDashboardState(client: HubClient): DashboardState {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    const onEvent = (event: Envelope) => dispatch({ kind: 'event', event });
    const offs = [
      client.onStatus((s) => dispatch({ kind: 'hub', connected: s === 'open' })),
      client.on('obs.', onEvent),
      client.on('platform.', onEvent),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return state;
}
```

`apps/dashboard/src/components/ScenePanel.tsx`:
```tsx
type Props = {
  scenes: string[];
  current: string | null;
  disabled: boolean;
  onSelect: (scene: string) => void;
};

export function ScenePanel({ scenes, current, disabled, onSelect }: Props) {
  return (
    <section className="panel">
      <h2>Scenes</h2>
      {scenes.length === 0 && <p className="muted">No scenes. Is OBS connected?</p>}
      <div className="scene-grid">
        {scenes.map((scene) => (
          <button
            key={scene}
            className={scene === current ? 'scene active' : 'scene'}
            aria-pressed={scene === current}
            disabled={disabled}
            onClick={() => onSelect(scene)}
          >
            {scene}
          </button>
        ))}
      </div>
    </section>
  );
}
```

`apps/dashboard/src/components/StatusBar.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { formatUptime, type DashboardState } from '../state';

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const Dot = ({ ok }: { ok: boolean }) => <span className={ok ? 'dot ok' : 'dot bad'} aria-hidden />;

export function StatusBar({ state }: { state: DashboardState }) {
  const now = useNow(1000);
  const { stream } = state;
  const platforms = Object.entries(state.platforms);
  return (
    <footer className="status-bar">
      <span><Dot ok={state.hubConnected} /> Hub</span>
      <span title={state.obs.detail}>
        <Dot ok={state.obs.connected} /> OBS{!state.obs.connected && state.obs.detail ? `: ${state.obs.detail}` : ''}
      </span>
      <span>
        <Dot ok={stream.state === 'live'} /> {stream.state}
        {stream.state === 'live' && stream.startedAt !== undefined && ` · ${formatUptime(now - stream.startedAt)}`}
      </span>
      {platforms.length === 0 ? (
        <span className="muted">No chat connectors yet</span>
      ) : (
        platforms.map(([platform, p]) => (
          <span key={platform} title={p?.detail}>
            <Dot ok={p?.status === 'live'} /> {platform}: {p?.status}
          </span>
        ))
      )}
    </footer>
  );
}
```

`apps/dashboard/src/App.tsx`:
```tsx
import type { HubClient } from '@streamhub/overlay-sdk';
import { ScenePanel } from './components/ScenePanel';
import { StatusBar } from './components/StatusBar';
import { StreamControls } from './components/StreamControls';
import { useDashboardState } from './useDashboardState';

export function App({ client }: { client: HubClient }) {
  const state = useDashboardState(client);
  const obsReady = state.hubConnected && state.obs.connected;
  return (
    <div className="app">
      <header>
        <h1>streamhub</h1>
        <StreamControls
          stream={state.stream}
          disabled={!obsReady}
          onStart={() => client.publish('obs.cmd.startStream')}
          onStop={() => client.publish('obs.cmd.stopStream')}
        />
      </header>
      <main>
        <ScenePanel
          scenes={state.scenes}
          current={state.currentScene}
          disabled={!obsReady}
          onSelect={(scene) => client.publish('obs.cmd.setScene', { scene })}
        />
        <section className="panel">
          <h2>Chat</h2>
          <p className="muted">Unified chat arrives in M2.</p>
        </section>
      </main>
      <StatusBar state={state} />
    </div>
  );
}
```

`apps/dashboard/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hub } from './hub';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={hub} />
  </StrictMode>,
);
```

`apps/dashboard/src/styles.css`:
```css
:root {
  --bg: #0f1115;
  --panel: #181b22;
  --text: #e8eaf0;
  --muted: #8a90a2;
  --accent: #6d5dfc;
  --danger: #e5484d;
  --ok: #30a46c;
  color-scheme: dark;
  font-family: system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.app { display: grid; grid-template-rows: auto 1fr auto; min-height: 100vh; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; }
h1 { font-size: 18px; margin: 0; }
h2 { font-size: 14px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 0 16px 16px; }
@media (max-width: 800px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border-radius: 10px; padding: 16px; }
.muted { color: var(--muted); }
button { font: inherit; color: var(--text); background: #262a35; border: 1px solid transparent; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary { background: var(--accent); font-weight: 600; }
button.danger { background: var(--danger); font-weight: 600; }
.stream-controls { display: flex; align-items: center; gap: 12px; }
.stream-controls .hint { margin: 0; font-size: 12px; color: var(--muted); max-width: 320px; }
.scene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.scene.active { border-color: var(--accent); background: #2b2550; }
.status-bar { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px 16px; font-size: 13px; background: var(--panel); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.dot.ok { background: var(--ok); }
.dot.bad { background: var(--danger); }
```

- [ ] **Step 7: Verify everything**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all PASS; `apps/dashboard/dist/index.html` exists.

Run: `pnpm dev`, then open http://127.0.0.1:5173.
Expected with OBS closed: Hub green, OBS red with a detail like `connect ECONNREFUSED`, buttons disabled. Start OBS (WebSocket enabled, password in `.env`): within ~60 s OBS turns green and the scenes appear in OBS order. Clicking a scene switches OBS. Reload the page: the current scene is highlighted at once. Quit OBS: OBS goes red; restart it: it reconnects.

Run: `pnpm start`, then open http://127.0.0.1:4747. Expected: the same dashboard is served by the hub.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(dashboard): scenes, confirmed stream start/stop and status bar"
```

---

### Task 7: Multistream setup, go-live checklist, docs aligned with the spec

**Files:**
- Create: `docs/multistream.md`, `docs/go-live.md`
- Modify: `ARCHITECTURE.md`, `CLAUDE.md`, `TASKS.md`

**Interfaces:**
- Consumes: the running system from Tasks 1–6.
- Produces: docs only. There is no code test; the deliverable is the manual go-live check in Step 4.

- [ ] **Step 1: Write `docs/multistream.md`**

````markdown
# Multistreaming (Twitch, YouTube, Kick, X)

streamhub never touches video. OBS streams to one platform with its normal output, and the **obs-multi-rtmp** plugin (GPL-2.0, installed separately) streams to the others. With "Sync start/stop with OBS" ticked, the dashboard's Start/Stop button controls every destination.

## 1. OBS
- OBS 30 or newer. Tools → WebSocket Server Settings → **Enable WebSocket server**, set a password, and put it in `.env` as `OBS_WS_PASSWORD`.
- Settings → Stream: your **main** platform (we use Twitch).

## 2. Install obs-multi-rtmp
Download the release for your OS from https://github.com/sorayuki/obs-multi-rtmp/releases and install it. Restart OBS. If it doesn't appear, open Docks → "Multiple output".

## 3. Add one target per extra platform
In the Multiple output dock → **Add new target**, for each:

| Platform | Where to get server + key |
|---|---|
| YouTube | YouTube Studio → Go live → Stream: Stream URL + Stream key |
| Kick | Kick dashboard → Settings → Stream URL & Key |
| X | studio.x.com → Producer → Sources → Create source (RTMP, your region) → URL + key. Then Broadcasts → Create broadcast using that source. |

In each target's settings, tick **Sync start with OBS** and **Sync stop with OBS**.

## 4. Encoder settings that work everywhere
If targets share the main encoder, choose settings every platform accepts. X allows at most 1080p30 at 12 Mbps (9 Mbps recommended). A safe default is **1080p30, ~6000 kbps, keyframe interval 2 s**. With a strong GPU, give targets their own encoder instead.

## Known limit
multi-rtmp has no remote API, so the dashboard only shows the main output's state. Watch the Multiple output dock in OBS for each target's health.
````

- [ ] **Step 2: Write `docs/go-live.md`**

```markdown
# Go-live checklist

Before every show:
1. OBS open; `pnpm start` running; dashboard at http://127.0.0.1:4747 shows **Hub** and **OBS** green.
2. Scenes in the dashboard match OBS; clicking one switches OBS.
3. multi-rtmp dock: every target has Sync start/stop ticked.

First time (and after changing any key), do a private test:
1. Set every platform to private/unlisted/test (YouTube unlisted, X broadcast not public, Twitch/Kick: test channel or short test).
2. Dashboard → Start stream → confirm. Within ~10 s every multi-rtmp target shows green and each platform shows the stream.
3. Dashboard → Stop stream → confirm. Every target stops.

(Chat checks are added here in M2 and M3.)
```

- [ ] **Step 3: Align the root docs with the spec**

`ARCHITECTURE.md`:
1. In "### 1. Event bus", replace `` `ws://127.0.0.1:4455/ws` `` and the following parenthetical with `` `ws://127.0.0.1:4747/ws` (config key `HUB_PORT`) ``. Replace the bullet about subscription syntax with: `- Clients subscribe by topic: "obs." is a prefix, "chat.message" is exact, "*" is everything. On subscribe the hub sends the latest retained state (see EVENTS.md).`
2. In "### 2. Connectors", replace the platform table with:
```markdown
| Platform | Approach | Notes |
|---|---|---|
| Twitch | EventSub over WebSocket, hub-direct | Spike first (M2). |
| YouTube | Data API v3 live chat, hub-direct | Quota math in the spike (M2). |
| Kick | Official webhooks via the **relay** (`apps/relay`, M3) | Opt-in unofficial Pusher fallback. |
| X | Video only (RTMP via multi-rtmp). Chat deferred: Enterprise/approval-only API, see `docs/connectors/x.md`. | |
```
3. Replace the line `- **Multistreaming is OBS's job** (multi-RTMP plugin or a relay service). The hub only starts/stops.` with `- **Multistreaming is OBS's job**: obs-multi-rtmp with "Sync start/stop with OBS" on every target, so the hub's start/stop drives all destinations. The hub only sees the main output's state. Setup: docs/multistream.md.`
4. Under "### 4. Scene transitions" and "### 5. Sequencer", add a first line to each: `> Not part of the base. Ships later as a module (see the spec).`
5. In "## Security", replace the Origin bullet with: `- Listen on 127.0.0.1 only. Reject WebSocket connections whose Origin is not the hub itself (or the Vite dev server in development). OBS Browser Sources load overlays from the hub, so they send the hub's origin. Modules additionally need their session token (M4).`
6. Add a section before "## Config & secrets":
```markdown
### 8. Relay (`apps/relay`, M3)
A hosted, self-hostable Cloudflare Worker that receives Kick webhooks and does Kick OAuth, and forwards events to the hub over a WebSocket the hub opens outbound. It is the only internet-facing component. Design: docs/superpowers/specs/2026-10-01-streamhub-base-design.md §4.3.
```

`CLAUDE.md`:
1. In "Hard rules", change the 127.0.0.1 bullet to: `- **Bind to 127.0.0.1 only.** The hub never accepts internet traffic. The relay (\`apps/relay\`) is the only internet-facing component.`
2. In "Stack", replace `— see \`TASKS.md\` M5.` with `— after the base is proven on a real stream.`
3. Replace the "Repo layout" block with:
```
apps/
  hub/          # Node process: bus, connectors, OBS bridge, HTTP/WS server
  dashboard/    # React control panel (scenes, stream control, status; chat in M2)
  relay/        # Cloudflare Worker for webhook-only platforms (Kick), M3
packages/
  shared/       # event types + zod schemas (single source of truth)
  overlay-sdk/  # client lib the dashboard and modules use to connect to the bus
modules/        # optional overlay modules, built live on stream (host lands in M4)
docs/           # multistream.md, go-live.md, connectors/, superpowers/specs|plans
```

`TASKS.md`: replace the whole file with:
```markdown
# TASKS.md — build order

The approved design is `docs/superpowers/specs/2026-10-01-streamhub-base-design.md` (§8 has the milestones). Detailed plans live in `docs/superpowers/plans/`.

- [x] M0 Skeleton + M1 Bus, OBS, multistream, dashboard (`plans/2026-10-01-streamhub-m0-m1-foundation.md`)
- [ ] M2 Direct chat: Twitch + YouTube (spikes first)
- [ ] M3 Relay + Kick
- [ ] M4 Module host + settings

## After the base
Tauri shell · then live-coded modules: chat overlay · featured message · transitions · sequencer · teleprompter · roast-o-meter · karaoke picker · hackathon voting · average-ness score · fake-money bets · chat-triggered sounds.
```

- [ ] **Step 4: M1 acceptance (manual, needs OBS + platform keys)**

Follow `docs/go-live.md` "First time" with private test streams.
Expected: one confirmed click puts every destination live, and one confirmed click stops all of them. Killing OBS shows "disconnected" in the dashboard, and it reconnects when OBS is back.
Record the result (date, OS, OBS version, multi-rtmp version, which platforms worked) at the bottom of `docs/go-live.md` under `## Verified`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: multistream guide, go-live checklist, align docs with base spec"
```
