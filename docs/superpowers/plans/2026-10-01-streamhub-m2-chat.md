# streamhub M2 (Twitch + YouTube chat, Connections, unified chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Twitch and YouTube chat arrive in one dashboard feed within ~2 s. The streamer connects both accounts from a Connections page, and one platform failing never affects the other.

**Architecture:**
- Each platform has three focused units under `apps/hub/src/connectors/<platform>/`:
  - an auth unit (tokens in a `0600` secrets file)
  - a pure normalizer (platform JSON → `ChatMessage`), tested on verbatim fixtures from the research docs
  - a connector (transport lifecycle with reconnect and backoff) that publishes to the bus
- Twitch uses EventSub WebSocket and Device Code Flow (no secret).
- YouTube uses gRPC `streamList`, with REST polling as fallback, and loopback OAuth + PKCE with the streamer's own Google client.
- A `ConnectionsService` turns `connections.cmd.*` bus commands into auth flows and retained `connections.state` events.
- The dashboard gains a chat panel and a Connections page.

**Tech Stack:** As M0+M1, plus `@grpc/grpc-js` and `@grpc/proto-loader` for YouTube streamList. Node's global `fetch` handles all HTTP. `ws` is used client-side for Twitch EventSub.

**Spec:** `docs/superpowers/specs/2026-10-01-streamhub-base-design.md`, amended §4.4, §4.6, §5 and §8. Research (binding for API details): `docs/connectors/twitch.md`, `docs/connectors/youtube.md`, `docs/connectors/youtube-stream_list.proto`.

All paths are relative to the repo root `Vanpelt streaming studio/`. Imports are extensionless; workspace packages are imported by name.

## Global Constraints

- Node 20+, TypeScript strict, ESM. The hub binds **127.0.0.1 only**.
- Chat platforms: `'twitch' | 'youtube' | 'kick'`. Kick is not implemented in M2: its connect command answers with an error state.
- **Secrets** (tokens, YouTube client id/secret) live only in `.streamhub/secrets.json` (gitignored, mode `0600`, atomic writes). They are never published on the bus, never sent to WebSocket clients, and never logged.
- Every new event type goes into `packages/shared` first, with `EVENTS.md` updated in the same commit.
- Connectors fail soft: they emit `platform.status` and retry with `backoffDelay` (1 s growing to 60 s, with jitter). They never throw out of a timer or socket callback.
- Treat all chat text as untrusted: render React text only, and only put `https:` URLs into `img src`/`href`.
- **Twitch:** EventSub WebSocket `wss://eventsub.wss.twitch.tv/ws`, scope `user:read:chat`, Device Code Flow with a Public client id from `TWITCH_CLIENT_ID`. Create subscriptions within 10 s of `session_welcome`. Validate the token at start and every hour.
- **YouTube:** scope `https://www.googleapis.com/auth/youtube.readonly`, loopback redirect `http://127.0.0.1:<HUB_PORT>/oauth/youtube/callback`, PKCE S256, bring-your-own Desktop OAuth client. Chat is kept in memory only. YouTube messages are visibly labelled "YouTube". The Connections page links the YouTube Terms of Service and Google Privacy Policy.
- Definition of done per task: `pnpm test`, `pnpm typecheck` and `pnpm lint` pass, and the disconnected case is handled.

## Review Focus

1. **Hostile chat content.** Text like `<img src=x onerror=alert(1)>`, `javascript:` emote URLs, very long messages. It must render as inert text and never execute or load. Pinned in Task 11 (`renders chat text literally`, `does not load non-https emote urls`).
2. **Secrets leaking to WebSocket clients or events.** The YouTube client secret and tokens must never appear in any bus event or WebSocket frame. Pinned in Task 1 (`never forwards connections commands to clients`) and Task 10 (`never publishes the client secret`).
3. **Twitch socket lifecycle edge cases.** Keepalive silence, `session_reconnect` handover, revocation, a malformed frame, duplicate deliveries. The feed must keep flowing without duplicates, and stop with a clear message only when the user must reconnect. Pinned in Task 5.
4. **YouTube when not live or after the stream ends.** It must show `offline`, re-check about every 60 s without burning quota, and resume when a new broadcast starts. Expired or revoked Google sign-in (7-day "Testing" expiry) must show "Reconnect YouTube" instead of looping. Pinned in Task 9.
5. **Dashboard reload mid-show.** It must backfill recent chat once, without duplicates, and keep live messages flowing. Pinned in Task 11 (`backfill merges without duplicates`).

---

### Task 1: Event contract for chat clears and connections; bus and WebSocket rules

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/events.test.ts`
- Modify: `apps/hub/src/bus/bus.ts` (`retainKey`)
- Modify: `apps/hub/src/bus/bus.test.ts`
- Modify: `apps/hub/src/ws/server.ts` (publishable and private prefixes)
- Modify: `apps/hub/src/ws/server.test.ts`
- Modify: `EVENTS.md`

**Interfaces:**
- Produces (from `@streamhub/shared`):
  - `ConnectionStateSchema`
  - `type ConnectionState = { platform: Platform; state: 'disconnected'|'pending'|'connected'|'error'; account?: string; detail?: string; userCode?: string; verificationUri?: string; authUrl?: string; clientConfigured?: boolean }`
  - Event types:
    - `chat.cleared` `{ platform: Platform; authorId?: string }`
    - `connections.state` `ConnectionState`
    - `connections.cmd.connect` `{ platform }`
    - `connections.cmd.disconnect` `{ platform }`
    - `connections.cmd.setYoutubeClient` `{ clientId: string; clientSecret: string }` (both trimmed, non-empty)
- Produces (hub):
  - The bus retains `connections.state` per platform.
  - `DASHBOARD_PUBLISHABLE` gains `'connections.cmd.'`.
  - New `NEVER_FORWARDED = ['connections.cmd.']`: those events are never sent to WebSocket clients.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/events.test.ts` (inside the file, after the existing `describe('validatePayload', …)` block):
```ts
describe('M2 events', () => {
  it('accepts chat.cleared with and without an author', () => {
    expect(validatePayload('chat.cleared', { platform: 'twitch' }).ok).toBe(true);
    expect(validatePayload('chat.cleared', { platform: 'youtube', authorId: 'UC1' }).ok).toBe(true);
  });
  it('accepts a pending Twitch connection state', () => {
    const r = validatePayload('connections.state', {
      platform: 'twitch',
      state: 'pending',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
    });
    expect(r.ok).toBe(true);
  });
  it('trims and requires the YouTube client credentials', () => {
    expect(validatePayload('connections.cmd.setYoutubeClient', { clientId: '  ', clientSecret: 's' }).ok).toBe(false);
    expect(validatePayload('connections.cmd.setYoutubeClient', { clientId: ' id ', clientSecret: ' s ' })).toEqual({
      ok: true,
      payload: { clientId: 'id', clientSecret: 's' },
    });
  });
  it('rejects connecting an unknown platform', () => {
    expect(validatePayload('connections.cmd.connect', { platform: 'x' }).ok).toBe(false);
  });
});
```

Append to `apps/hub/src/bus/bus.test.ts` inside `describe('Bus', …)`:
```ts
  it('retains connection state per platform', () => {
    const bus = new Bus();
    bus.publish({ type: 'connections.state', payload: { platform: 'twitch', state: 'pending' }, source: 'hub' });
    bus.publish({ type: 'connections.state', payload: { platform: 'youtube', state: 'disconnected' }, source: 'hub' });
    bus.publish({ type: 'connections.state', payload: { platform: 'twitch', state: 'connected', account: 'yatf' }, source: 'hub' });
    const states = bus.retainedFor(['connections.']).map((e) => e.payload);
    expect(states).toEqual([
      { platform: 'youtube', state: 'disconnected' },
      { platform: 'twitch', state: 'connected', account: 'yatf' },
    ]);
  });
```

Append to `apps/hub/src/ws/server.test.ts` inside `describe('ops', …)`:
```ts
  it('lets dashboards send connection commands', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['connections.cmd.'], (e) => seen.push(e.payload));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'connections.cmd.connect', payload: { platform: 'twitch' } } });
    await sync(c);
    expect(seen).toEqual([{ platform: 'twitch' }]);
  });

  it('never forwards connections commands to clients', async () => {
    const watcher = await open(ORIGIN);
    watcher.send({ op: 'subscribe', topics: ['*'] });
    await sync(watcher);
    const sender = await open(ORIGIN);
    sender.send({
      op: 'publish',
      event: { type: 'connections.cmd.setYoutubeClient', payload: { clientId: 'id', clientSecret: 'TOPSECRET' } },
    });
    await sync(sender);
    await sync(watcher); // would receive the command first if it were forwarded
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/shared exec vitest run && pnpm --filter @streamhub/hub exec vitest run src/bus src/ws`
Expected: FAIL. The new event types are unknown, `connections.state` isn't retained, and the dashboard can't publish `connections.cmd.*` (`forbidden`).

- [ ] **Step 3: Implement**

In `packages/shared/src/events.ts`, add after `StreamStateSchema`:
```ts
export const ConnectionStateSchema = z.object({
  platform: PlatformSchema,
  state: z.enum(['disconnected', 'pending', 'connected', 'error']),
  account: z.string().optional(),
  detail: z.string().optional(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  authUrl: z.string().optional(),
  clientConfigured: z.boolean().optional(),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
```
and add these entries to `EventSchemas` (after `'chat.deleted'`, and after `'show.feature.clear'` respectively):
```ts
  'chat.cleared': z.object({ platform: PlatformSchema, authorId: z.string().optional() }),
```
```ts
  'connections.state': ConnectionStateSchema,
  'connections.cmd.connect': z.object({ platform: PlatformSchema }),
  'connections.cmd.disconnect': z.object({ platform: PlatformSchema }),
  'connections.cmd.setYoutubeClient': z.object({
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
  }),
```

In `apps/hub/src/bus/bus.ts`, replace `retainKey` with:
```ts
const PER_PLATFORM_RETAINED = new Set(['platform.status', 'connections.state']);

function retainKey(e: Envelope): string | null {
  if (RETAINED_TYPES.has(e.type)) return e.type;
  if (PER_PLATFORM_RETAINED.has(e.type)) {
    return `${e.type}:${(e.payload as { platform: string }).platform}`;
  }
  return null;
}
```

In `apps/hub/src/ws/server.ts`, replace the `DASHBOARD_PUBLISHABLE` line with:
```ts
/** Event prefixes a dashboard client may publish. Modules get their own rules in M4. */
export const DASHBOARD_PUBLISHABLE = ['obs.cmd.', 'show.', 'connections.cmd.'];
/** Events that may carry secrets: handled inside the hub, never sent to any client. */
export const NEVER_FORWARDED = ['connections.cmd.'];
```
and change the bus subscription in `handleClient` to:
```ts
  const unsubscribe = bus.subscribe(['*'], (event) => {
    if (NEVER_FORWARDED.some((p) => event.type.startsWith(p))) return;
    if (topicMatches(topics, event.type)) send(event);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Update `EVENTS.md`**
1. In the Chat table, add the row `| \`chat.cleared\` | \`{ platform: Platform; authorId?: string }\`: whole chat cleared, or one user's messages removed |`.
2. Add a section before "## Module events":
````markdown
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
````
3. In the "Limits" paragraph, change "Dashboard clients may publish only `obs.cmd.*` and `show.*`." to "Dashboard clients may publish only `obs.cmd.*`, `show.*` and `connections.cmd.*`."

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "feat(shared): chat.cleared and connections events; never forward connection commands"
```

---

### Task 2: Secrets store, shared timer and test helpers, Twitch client id config

**Files:**
- Create: `apps/hub/src/secrets/store.ts`, `apps/hub/src/secrets/store.test.ts`
- Create: `apps/hub/src/util/timer.ts`, `apps/hub/src/util/errors.ts`
- Create: `apps/hub/src/testing/timer.ts`, `apps/hub/src/testing/http.ts`
- Modify: `apps/hub/src/obs/bridge.ts` (import `Timer`/`realTimer` from `util/timer`)
- Modify: `apps/hub/src/config.ts`, `apps/hub/src/config.test.ts`
- Modify: `.gitignore`, `.env.example`

**Interfaces:**
- Produces:
  - `type TwitchSecrets = { accessToken: string; refreshToken: string; userId: string; login: string }`
  - `type YouTubeSecrets = { clientId: string; clientSecret: string; accessToken?: string; refreshToken?: string; expiresAt?: number; channelTitle?: string }`
  - `type Secrets = { twitch?: TwitchSecrets; youtube?: YouTubeSecrets }`
  - `class SecretsStore { constructor(path: string); load(): Promise<void>; get(): Secrets; update(fn: (current: Secrets) => Secrets): Promise<void> }`
  - `type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }`, `realTimer: Timer` (`util/timer.ts`). `obs/bridge.ts` keeps exporting `Timer`.
  - `describeError(err: unknown): string` (`util/errors.ts`)
  - Test-only:
    - `class FakeTimer implements Timer { queue; set; clear; fire(ms: number): void; has(ms: number): boolean }`
    - `settle(): Promise<void>` (`testing/timer.ts`)
    - `json(status, body): Response`
    - `fakeFetch(handler: (req: { url: string; form: URLSearchParams; init: RequestInit }) => Response | Promise<Response>): typeof fetch & { calls: Array<{ url: string; form: URLSearchParams; init: RequestInit }> }` (`testing/http.ts`)
  - `HubConfig` gains `twitchClientId: string` (`''` when unset).

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/secrets/store.test.ts`:
```ts
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from './store';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-secrets-'));
  path = join(dir, '.streamhub', 'secrets.json');
});

const twitch = { accessToken: 'a', refreshToken: 'r', userId: '1', login: 'yatf' };

describe('SecretsStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = new SecretsStore(path);
    await store.load();
    expect(store.get()).toEqual({});
  });

  it('persists updates and reloads them', async () => {
    const store = new SecretsStore(path);
    await store.load();
    await store.update((s) => ({ ...s, twitch }));
    const again = new SecretsStore(path);
    await again.load();
    expect(again.get()).toEqual({ twitch });
  });

  it.skipIf(process.platform === 'win32')('writes the file readable by the owner only', async () => {
    const store = new SecretsStore(path);
    await store.update((s) => ({ ...s, twitch }));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('applies concurrent updates in order', async () => {
    const store = new SecretsStore(path);
    await Promise.all([
      store.update((s) => ({ ...s, twitch })),
      store.update((s) => ({ ...s, youtube: { clientId: 'c', clientSecret: 's' } })),
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      twitch,
      youtube: { clientId: 'c', clientSecret: 's' },
    });
  });

  it('returns copies so callers cannot mutate stored secrets', async () => {
    const store = new SecretsStore(path);
    await store.update((s) => ({ ...s, twitch }));
    store.get().twitch!.accessToken = 'mutated';
    expect(store.get().twitch!.accessToken).toBe('a');
  });

  it('moves an unreadable file aside and starts empty', async () => {
    const store = new SecretsStore(path);
    await store.update((s) => ({ ...s, twitch }));
    await writeFile(path, '{ not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const again = new SecretsStore(path);
    await again.load();
    expect(again.get()).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('.corrupt-'));
  });
});
```

Add to `apps/hub/src/config.test.ts` inside the describe:
```ts
  it('reads the Twitch client id, empty by default', () => {
    expect(loadConfig({}).twitchClientId).toBe('');
    expect(loadConfig({ TWITCH_CLIENT_ID: ' abc123 ' }).twitchClientId).toBe('abc123');
  });
```
and add `twitchClientId: ''` to the expected object in the `'uses defaults for missing or blank values'` test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/secrets src/config.test.ts`
Expected: FAIL. `./store` is not found and `twitchClientId` is undefined.

- [ ] **Step 3: Implement**

`apps/hub/src/secrets/store.ts`:
```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TwitchSecrets = { accessToken: string; refreshToken: string; userId: string; login: string };
export type YouTubeSecrets = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  channelTitle?: string;
};
export type Secrets = { twitch?: TwitchSecrets; youtube?: YouTubeSecrets };

/** Local secrets file: owner-only permissions, atomic replace, serialized writes. Never log its contents. */
export class SecretsStore {
  private data: Secrets = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = {};
        return;
      }
      throw err;
    }
    try {
      this.data = JSON.parse(text) as Secrets;
    } catch {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup);
      console.warn(`[secrets] unreadable secrets file moved to ${backup}; starting empty`);
      this.data = {};
    }
  }

  get(): Secrets {
    return structuredClone(this.data);
  }

  update(fn: (current: Secrets) => Secrets): Promise<void> {
    const next = this.writing.then(async () => {
      const data = fn(structuredClone(this.data));
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
      this.data = data;
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
```

`apps/hub/src/util/timer.ts`:
```ts
export type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
```

`apps/hub/src/util/errors.ts`:
```ts
export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
```

In `apps/hub/src/obs/bridge.ts`:
- delete the local `export type Timer = …` line and the local `const realTimer: Timer = {…};` block
- add at the top: `import { realTimer, type Timer } from '../util/timer';` and `export type { Timer } from '../util/timer';`

`apps/hub/src/testing/timer.ts`:
```ts
import type { Timer } from '../util/timer';

export class FakeTimer implements Timer {
  queue: Array<{ fn: () => void; ms: number }> = [];
  set(fn: () => void, ms: number) {
    const entry = { fn, ms };
    this.queue.push(entry);
    return entry;
  }
  clear(handle: unknown) {
    this.queue = this.queue.filter((e) => e !== handle);
  }
  /** Runs (and removes) the first pending timer with exactly this delay. */
  fire(ms: number) {
    const i = this.queue.findIndex((e) => e.ms === ms);
    if (i < 0) throw new Error(`no timer pending at ${ms}ms (pending: ${this.queue.map((e) => e.ms).join(', ')})`);
    const [entry] = this.queue.splice(i, 1);
    entry!.fn();
  }
  has(ms: number) {
    return this.queue.some((e) => e.ms === ms);
  }
}

/** Lets chained promises and immediates run. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
```

`apps/hub/src/testing/http.ts`:
```ts
export type FakeRequest = { url: string; form: URLSearchParams; init: RequestInit };

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function fakeFetch(handler: (req: FakeRequest) => Response | Promise<Response>) {
  const calls: FakeRequest[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = {
      url: String(input),
      form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
      init,
    };
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}
```

In `apps/hub/src/config.ts`, add to `EnvSchema`:
```ts
  TWITCH_CLIENT_ID: z.preprocess(blankToUndefined, z.string().trim().default('')),
```
add `twitchClientId: string;` to `HubConfig`, and `twitchClientId: e.TWITCH_CLIENT_ID,` to the returned object.

Append to `.gitignore`:
```
.streamhub/
```
Append to `.env.example`:
```
# Twitch app Client ID (Public client type) — see docs/setup/twitch.md
TWITCH_CLIENT_ID=
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. The existing bridge tests still pass with `Timer` re-exported.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): owner-only secrets store, shared timer/test helpers, TWITCH_CLIENT_ID config"
```

---

### Task 3: Twitch auth (Device Code Flow, refresh, validate)

**Files:**
- Create: `apps/hub/src/connectors/twitch/auth.ts`, `apps/hub/src/connectors/twitch/auth.test.ts`

**Interfaces:**
- Consumes: `SecretsStore`, `TwitchSecrets` (Task 2); `fakeFetch`, `json` (Task 2, tests).
- Produces:
  - `TWITCH_SCOPES = 'user:read:chat'`
  - `class TwitchAuthError extends Error`
  - `type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; intervalMs: number; expiresAt: number }`
  - `class TwitchAuth`:
    - `constructor(opts: { clientId: string; store: SecretsStore; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number })`
    - `tokens(): TwitchSecrets | undefined`
    - `startDeviceFlow(): Promise<DeviceCode>`
    - `pollDeviceFlow(code: DeviceCode, signal?: AbortSignal): Promise<TwitchSecrets>`
    - `refresh(): Promise<TwitchSecrets>` (single-flight)
    - `validate(): Promise<boolean>`
    - `helix(path: string, init?: RequestInit): Promise<Response>` (adds Bearer + Client-Id, refreshes once on 401)
    - `clear(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/connectors/twitch/auth.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretsStore } from '../../secrets/store';
import { fakeFetch, json } from '../../testing/http';
import { TwitchAuth, TwitchAuthError, type DeviceCode } from './auth';

let store: SecretsStore;
beforeEach(async () => {
  store = new SecretsStore(join(await mkdtemp(join(tmpdir(), 'twitch-auth-')), 'secrets.json'));
});

const validateOk = json(200, { client_id: 'cid', login: 'yatf', scopes: ['user:read:chat'], user_id: '42', expires_in: 14000 });
const code: DeviceCode = { deviceCode: 'dev', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate', intervalMs: 5000, expiresAt: 1_000_000 };
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

describe('TwitchAuth device flow', () => {
  it('starts the flow with the public client id and scope', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { device_code: 'dev', expires_in: 1800, interval: 5, user_code: 'ABCDEFGH', verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' }),
    );
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, now: () => 1000 });
    expect(await auth.startDeviceFlow()).toEqual({
      deviceCode: 'dev',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
      intervalMs: 5000,
      expiresAt: 1000 + 1_800_000,
    });
    expect(fetchFn.calls[0]!.url).toBe('https://id.twitch.tv/oauth2/device');
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({ client_id: 'cid', scopes: 'user:read:chat' });
  });

  it('polls until approved, then stores tokens with the validated identity', async () => {
    let polls = 0;
    const fetchFn = fakeFetch(({ url }) => {
      if (url.endsWith('/validate')) return validateOk;
      polls++;
      return polls < 3
        ? json(400, { status: 400, message: 'authorization_pending' })
        : json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 14000, scope: ['user:read:chat'], token_type: 'bearer' });
    });
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep, now: () => 0 });
    const tokens = await auth.pollDeviceFlow(code);
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', userId: '42', login: 'yatf' });
    expect(store.get().twitch).toEqual(tokens);
    expect(sleeps.slice(-3)).toEqual([5000, 5000, 5000]);
    const tokenCall = fetchFn.calls.find((c) => c.url.endsWith('/token'))!;
    expect(tokenCall.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(tokenCall.form.get('device_code')).toBe('dev');
  });

  it('stops on any other error', async () => {
    const fetchFn = fakeFetch(() => json(400, { status: 400, message: 'invalid device code' }));
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep, now: () => 0 });
    await expect(auth.pollDeviceFlow(code)).rejects.toThrow('invalid device code');
  });

  it('gives up when the code expires', async () => {
    const fetchFn = fakeFetch(() => json(400, { status: 400, message: 'authorization_pending' }));
    let t = 0;
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep: async () => void (t += 600_000), now: () => t });
    await expect(auth.pollDeviceFlow(code)).rejects.toThrow('expired');
  });

  it('can be cancelled', async () => {
    const fetchFn = fakeFetch(() => json(400, { status: 400, message: 'authorization_pending' }));
    const abort = new AbortController();
    abort.abort();
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep, now: () => 0 });
    await expect(auth.pollDeviceFlow(code, abort.signal)).rejects.toBeInstanceOf(TwitchAuthError);
  });
});

describe('TwitchAuth tokens', () => {
  const seed = () => store.update((s) => ({ ...s, twitch: { accessToken: 'old', refreshToken: 'r1', userId: '42', login: 'yatf' } }));

  it('refreshes once on 401 and retries Helix with the new token', async () => {
    await seed();
    const fetchFn = fakeFetch(({ url, init }) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'new', refresh_token: 'r2' });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(202, { data: [] }) : json(401, {});
    });
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn });
    const res = await auth.helix('/eventsub/subscriptions', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(store.get().twitch).toMatchObject({ accessToken: 'new', refreshToken: 'r2' });
    const refresh = fetchFn.calls.find((c) => c.url.endsWith('/token'))!;
    expect(Object.fromEntries(refresh.form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid' });
    const helixCall = fetchFn.calls.find((c) => c.url.includes('/helix/'))!;
    expect((helixCall.init.headers as Record<string, string>)['Client-Id']).toBe('cid');
  });

  it('refreshes only once for concurrent 401s (one-time refresh tokens)', async () => {
    await seed();
    const fetchFn = fakeFetch(({ url, init }) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'new', refresh_token: 'r2' });
      return (init.headers as Record<string, string>).Authorization === 'Bearer new' ? json(200, {}) : json(401, {});
    });
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn });
    await Promise.all([auth.helix('/a'), auth.helix('/b')]);
    expect(fetchFn.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it('validate is false when the token is dead and refresh fails', async () => {
    await seed();
    const fetchFn = fakeFetch(({ url }) =>
      url.endsWith('/validate') ? json(401, { status: 401, message: 'invalid access token' }) : json(400, { status: 400, message: 'Invalid refresh token' }),
    );
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn });
    expect(await auth.validate()).toBe(false);
  });

  it('validate is true for a live token', async () => {
    await seed();
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn: fakeFetch(() => validateOk) });
    expect(await auth.validate()).toBe(true);
  });

  it('clear removes the Twitch tokens only', async () => {
    await seed();
    await store.update((s) => ({ ...s, youtube: { clientId: 'c', clientSecret: 's' } }));
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn: fakeFetch(() => validateOk) });
    await auth.clear();
    expect(store.get()).toEqual({ youtube: { clientId: 'c', clientSecret: 's' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/twitch/auth.test.ts`
Expected: FAIL, `./auth` not found.

- [ ] **Step 3: Implement**

`apps/hub/src/connectors/twitch/auth.ts`:
```ts
import type { SecretsStore, TwitchSecrets } from '../../secrets/store';

const ID_URL = 'https://id.twitch.tv/oauth2';
const HELIX_URL = 'https://api.twitch.tv/helix';
export const TWITCH_SCOPES = 'user:read:chat';

export class TwitchAuthError extends Error {}

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
};

type Options = {
  clientId: string;
  store: SecretsStore;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Device Code Grant Flow for a Public client (no secret). See docs/connectors/twitch.md §2. */
export class TwitchAuth {
  private refreshing: Promise<TwitchSecrets> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: Options) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  tokens(): TwitchSecrets | undefined {
    return this.opts.store.get().twitch;
  }

  async startDeviceFlow(): Promise<DeviceCode> {
    const res = await this.post('/device', { client_id: this.opts.clientId, scopes: TWITCH_SCOPES });
    if (!res.ok) throw new TwitchAuthError(`Twitch refused to start sign-in (${res.status})`);
    const b = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };
    return {
      deviceCode: b.device_code,
      userCode: b.user_code,
      verificationUri: b.verification_uri,
      intervalMs: b.interval * 1000,
      expiresAt: this.now() + b.expires_in * 1000,
    };
  }

  async pollDeviceFlow(code: DeviceCode, signal?: AbortSignal): Promise<TwitchSecrets> {
    while (this.now() < code.expiresAt) {
      if (signal?.aborted) throw new TwitchAuthError('sign-in cancelled');
      await this.sleep(code.intervalMs);
      if (signal?.aborted) throw new TwitchAuthError('sign-in cancelled');
      const res = await this.post('/token', {
        client_id: this.opts.clientId,
        scopes: TWITCH_SCOPES,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return this.saveTokens(String(body.access_token), String(body.refresh_token));
      if (body.message === 'authorization_pending') continue;
      throw new TwitchAuthError(`Twitch rejected the sign-in: ${String(body.message ?? res.status)}`);
    }
    throw new TwitchAuthError('The code expired before it was approved. Try again.');
  }

  /** Required by Twitch at startup and hourly. False means the user must reconnect. */
  async validate(): Promise<boolean> {
    const t = this.tokens();
    if (!t) return false;
    if (await this.whoAmI(t.accessToken)) return true;
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  refresh(): Promise<TwitchSecrets> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async helix(path: string, init: RequestInit = {}): Promise<Response> {
    const t = this.tokens();
    if (!t) throw new TwitchAuthError('Twitch is not connected');
    const send = (token: string) =>
      this.fetchFn(`${HELIX_URL}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
          'Client-Id': this.opts.clientId,
        },
      });
    const res = await send(t.accessToken);
    if (res.status !== 401) return res;
    const fresh = await this.refresh();
    return send(fresh.accessToken);
  }

  async clear(): Promise<void> {
    await this.opts.store.update((s) => {
      const rest = { ...s };
      delete rest.twitch;
      return rest;
    });
  }

  private async doRefresh(): Promise<TwitchSecrets> {
    const t = this.tokens();
    if (!t) throw new TwitchAuthError('Twitch is not connected');
    const res = await this.post('/token', {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: this.opts.clientId,
    });
    if (!res.ok) throw new TwitchAuthError(`Twitch token refresh failed (${res.status})`);
    const b = (await res.json()) as { access_token: string; refresh_token: string };
    const next = { ...t, accessToken: b.access_token, refreshToken: b.refresh_token };
    await this.opts.store.update((s) => ({ ...s, twitch: next }));
    return next;
  }

  private async saveTokens(accessToken: string, refreshToken: string): Promise<TwitchSecrets> {
    const who = await this.whoAmI(accessToken);
    if (!who) throw new TwitchAuthError('Twitch returned a token that does not validate');
    const tokens = { accessToken, refreshToken, ...who };
    await this.opts.store.update((s) => ({ ...s, twitch: tokens }));
    return tokens;
  }

  private async whoAmI(token: string): Promise<{ userId: string; login: string } | null> {
    const res = await this.fetchFn(`${ID_URL}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (res.status === 401) return null;
    if (!res.ok) throw new TwitchAuthError(`Twitch token validation failed (${res.status})`);
    const b = (await res.json()) as { user_id: string; login: string };
    return { userId: b.user_id, login: b.login };
  }

  private post(path: string, form: Record<string, string>) {
    return this.fetchFn(`${ID_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/twitch/auth.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): Twitch device code auth with single-flight refresh and validation"
```

---

### Task 4: Twitch normalizer and fixtures

**Files:**
- Create: `apps/hub/src/connectors/twitch/normalize.ts`, `apps/hub/src/connectors/twitch/normalize.test.ts`
- Create: `apps/hub/src/connectors/twitch/fixtures/chat-message.json`, `chat-emotes.json`, `message-delete.json`

**Interfaces:**
- Produces:
  - `type TwitchFragment = { type: string; text: string; emote?: { id: string; format?: string[] } | null; mention?: { user_name: string } | null; gif?: { url?: string } | null }`
  - `type TwitchChatEvent = { broadcaster_user_id: string; broadcaster_user_login: string; chatter_user_id: string; chatter_user_name: string; message_id: string; message: { text: string; fragments: TwitchFragment[] }; color: string; badges: Array<{ set_id: string }> }`
  - `normalizeTwitchMessage(event: TwitchChatEvent, messageTimestamp: string, now?: () => number): ChatMessage`
  - `normalizeTwitchDelete(event: { message_id: string }): { id: string }`
  - `normalizeTwitchClear(event: { target_user_id?: string }): { platform: 'twitch'; authorId?: string }`
  - `twitchEmoteUrl(id: string, formats?: string[]): string`

- [ ] **Step 1: Create the fixtures (verbatim payloads from `docs/connectors/twitch.md` §4, inside the notification envelope)**

`apps/hub/src/connectors/twitch/fixtures/chat-message.json`:
```json
{
  "metadata": {
    "message_id": "befa7b53-d79d-478f-86b9-120f112b044e",
    "message_type": "notification",
    "message_timestamp": "2023-11-06T18:11:47.492253549Z",
    "subscription_type": "channel.chat.message",
    "subscription_version": "1"
  },
  "payload": {
    "subscription": {
      "id": "0b7f3361-672b-4d39-b307-dd5b576c9b27",
      "status": "enabled",
      "type": "channel.chat.message",
      "version": "1",
      "condition": { "broadcaster_user_id": "1971641", "user_id": "2914196" },
      "transport": { "method": "websocket", "session_id": "AgoQHR3s6Mb4T8GFB1l3DlPfiRIGY2VsbC1h" },
      "created_at": "2023-11-06T18:11:47.492253549Z",
      "cost": 0
    },
    "event": {
      "broadcaster_user_id": "1971641",
      "broadcaster_user_login": "streamer",
      "broadcaster_user_name": "streamer",
      "chatter_user_id": "4145994",
      "chatter_user_login": "viewer32",
      "chatter_user_name": "viewer32",
      "message_id": "cc106a89-1814-919d-454c-f4f2f970aae7",
      "message": {
        "text": "Hi chat",
        "fragments": [{ "type": "text", "text": "Hi chat", "cheermote": null, "emote": null, "mention": null }]
      },
      "color": "#00FF7F",
      "badges": [
        { "set_id": "moderator", "id": "1", "info": "" },
        { "set_id": "subscriber", "id": "12", "info": "16" },
        { "set_id": "sub-gifter", "id": "1", "info": "" }
      ],
      "message_type": "text",
      "cheer": null,
      "reply": null,
      "channel_points_custom_reward_id": null,
      "source_broadcaster_user_id": null,
      "source_broadcaster_user_login": null,
      "source_broadcaster_user_name": null,
      "source_message_id": null,
      "source_badges": null
    }
  }
}
```

`apps/hub/src/connectors/twitch/fixtures/chat-emotes.json` (the regular event with the documented emote `message`):
```json
{
  "metadata": {
    "message_id": "0f4c2a1e-0000-4000-8000-000000000002",
    "message_type": "notification",
    "message_timestamp": "2023-11-06T18:12:00.000000001Z",
    "subscription_type": "channel.chat.message",
    "subscription_version": "1"
  },
  "payload": {
    "subscription": { "id": "0b7f3361-672b-4d39-b307-dd5b576c9b27", "status": "enabled", "type": "channel.chat.message", "version": "1", "condition": { "broadcaster_user_id": "1971641", "user_id": "1971641" }, "transport": { "method": "websocket", "session_id": "S" }, "created_at": "2023-11-06T18:11:47.492253549Z", "cost": 0 },
    "event": {
      "broadcaster_user_id": "1971641",
      "broadcaster_user_login": "streamer",
      "broadcaster_user_name": "streamer",
      "chatter_user_id": "1971641",
      "chatter_user_login": "streamer",
      "chatter_user_name": "streamer",
      "message_id": "aa000000-0000-4000-8000-000000000002",
      "message": {
        "text": "RAID TombRaid RAID twitchRaid RAID",
        "fragments": [
          { "type": "text", "text": "RAID ", "cheermote": null, "emote": null, "mention": null },
          { "type": "emote", "text": "TombRaid", "cheermote": null, "emote": { "id": "864205", "emote_set_id": "0", "owner_id": "0", "format": ["static"] }, "mention": null },
          { "type": "text", "text": " RAID ", "cheermote": null, "emote": null, "mention": null },
          { "type": "emote", "text": "twitchRaid", "cheermote": null, "emote": { "id": "62836", "emote_set_id": "0", "owner_id": "0", "format": ["static", "animated"] }, "mention": null },
          { "type": "text", "text": " RAID", "cheermote": null, "emote": null, "mention": null }
        ]
      },
      "color": "",
      "badges": [{ "set_id": "broadcaster", "id": "1", "info": "" }],
      "message_type": "text",
      "cheer": null,
      "reply": null
    }
  }
}
```
(The second emote's `format` includes `"animated"` on purpose, to exercise the animated URL.)

`apps/hub/src/connectors/twitch/fixtures/message-delete.json`:
```json
{
  "metadata": {
    "message_id": "0f4c2a1e-0000-4000-8000-000000000003",
    "message_type": "notification",
    "message_timestamp": "2023-04-11T10:11:12.123Z",
    "subscription_type": "channel.chat.message_delete",
    "subscription_version": "1"
  },
  "payload": {
    "subscription": { "id": "f1c2a387-161a-49f9-a165-0f21d7a4e1c4", "type": "channel.chat.message_delete", "version": "1", "status": "enabled", "cost": 0, "condition": { "broadcaster_user_id": "1337", "user_id": "9001" }, "transport": { "method": "websocket", "session_id": "S" }, "created_at": "2023-04-11T10:11:12.123Z" },
    "event": {
      "broadcaster_user_id": "1337",
      "broadcaster_user_name": "Cool_User",
      "broadcaster_user_login": "cool_user",
      "target_user_id": "7734",
      "target_user_name": "Uncool_viewer",
      "target_user_login": "uncool_viewer",
      "message_id": "ab24e0b0-2260-4bac-94e4-05eedd4ecd0e"
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`apps/hub/src/connectors/twitch/normalize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ChatMessageSchema } from '@streamhub/shared';
import chatMessage from './fixtures/chat-message.json';
import chatEmotes from './fixtures/chat-emotes.json';
import messageDelete from './fixtures/message-delete.json';
import {
  normalizeTwitchClear,
  normalizeTwitchDelete,
  normalizeTwitchMessage,
  twitchEmoteUrl,
  type TwitchChatEvent,
} from './normalize';

const now = () => 123;

describe('normalizeTwitchMessage', () => {
  it('maps the documented regular chat message', () => {
    const msg = normalizeTwitchMessage(chatMessage.payload.event as TwitchChatEvent, chatMessage.metadata.message_timestamp, now);
    expect(msg).toEqual({
      id: 'twitch:cc106a89-1814-919d-454c-f4f2f970aae7',
      platform: 'twitch',
      channel: 'streamer',
      author: { id: '4145994', name: 'viewer32', color: '#00FF7F', roles: ['moderator', 'subscriber'] },
      text: 'Hi chat',
      fragments: [{ kind: 'text', text: 'Hi chat' }],
      sentAt: Date.parse('2023-11-06T18:11:47.492Z'),
    });
    expect(ChatMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('maps emotes to CDN urls, preferring animated, and the broadcaster to owner', () => {
    const msg = normalizeTwitchMessage(chatEmotes.payload.event as TwitchChatEvent, chatEmotes.metadata.message_timestamp, now);
    expect(msg.author).toEqual({ id: '1971641', name: 'streamer', color: undefined, roles: ['owner'] });
    expect(msg.fragments).toEqual([
      { kind: 'text', text: 'RAID ' },
      { kind: 'emote', name: 'TombRaid', url: 'https://static-cdn.jtvnw.net/emoticons/v2/864205/static/dark/2.0' },
      { kind: 'text', text: ' RAID ' },
      { kind: 'emote', name: 'twitchRaid', url: 'https://static-cdn.jtvnw.net/emoticons/v2/62836/animated/dark/2.0' },
      { kind: 'text', text: ' RAID' },
    ]);
  });

  it('maps mentions, cheermotes and gifs', () => {
    const event = {
      ...(chatMessage.payload.event as TwitchChatEvent),
      message: {
        text: '@viewer32 cheer100 gif',
        fragments: [
          { type: 'mention', text: '@viewer32', mention: { user_name: 'viewer32' } },
          { type: 'text', text: ' ' },
          { type: 'cheermote', text: 'cheer100' },
          { type: 'gif', text: 'gif', gif: { url: 'https://media.example/g.gif' } },
        ],
      },
    };
    expect(normalizeTwitchMessage(event, '2023-11-06T18:11:47Z', now).fragments).toEqual([
      { kind: 'mention', name: 'viewer32' },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'cheer100' },
      { kind: 'emote', name: 'gif', url: 'https://media.example/g.gif' },
    ]);
  });

  it('maps vip, founder and lead_moderator badges', () => {
    const event = { ...(chatMessage.payload.event as TwitchChatEvent), badges: [{ set_id: 'vip' }, { set_id: 'founder' }, { set_id: 'lead_moderator' }] };
    expect(normalizeTwitchMessage(event, '2023-11-06T18:11:47Z', now).author.roles).toEqual(['vip', 'subscriber', 'moderator']);
  });

  it('falls back to now for an unparseable timestamp', () => {
    expect(normalizeTwitchMessage(chatMessage.payload.event as TwitchChatEvent, 'garbage', now).sentAt).toBe(123);
  });
});

describe('deletes and clears', () => {
  it('maps a deleted message to its normalized id', () => {
    expect(normalizeTwitchDelete(messageDelete.payload.event)).toEqual({ id: 'twitch:ab24e0b0-2260-4bac-94e4-05eedd4ecd0e' });
  });
  it('maps a full clear and a per-user clear', () => {
    expect(normalizeTwitchClear({})).toEqual({ platform: 'twitch' });
    expect(normalizeTwitchClear({ target_user_id: '7734' })).toEqual({ platform: 'twitch', authorId: '7734' });
  });
});

describe('twitchEmoteUrl', () => {
  it('defaults to static', () => {
    expect(twitchEmoteUrl('1')).toBe('https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/2.0');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/twitch/normalize.test.ts`
Expected: FAIL, `./normalize` not found.

- [ ] **Step 4: Implement**

`apps/hub/src/connectors/twitch/normalize.ts`:
```ts
import type { ChatMessage } from '@streamhub/shared';

export type TwitchFragment = {
  type: string;
  text: string;
  emote?: { id: string; format?: string[] } | null;
  mention?: { user_name: string } | null;
  gif?: { url?: string } | null;
};

export type TwitchChatEvent = {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  chatter_user_id: string;
  chatter_user_name: string;
  message_id: string;
  message: { text: string; fragments: TwitchFragment[] };
  color: string;
  badges: Array<{ set_id: string }>;
};

type Role = ChatMessage['author']['roles'][number];

const BADGE_ROLES: Record<string, Role> = {
  broadcaster: 'owner',
  moderator: 'moderator',
  lead_moderator: 'moderator',
  vip: 'vip',
  subscriber: 'subscriber',
  founder: 'subscriber',
};

export function twitchEmoteUrl(id: string, formats: string[] = ['static']): string {
  const format = formats.includes('animated') ? 'animated' : 'static';
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/${format}/dark/2.0`;
}

/** RFC3339 with nanoseconds → epoch ms. */
function parseTimestamp(ts: string, now: () => number): number {
  const ms = Date.parse(ts.replace(/(\.\d{3})\d*Z$/, '$1Z'));
  return Number.isNaN(ms) ? now() : ms;
}

function fragment(f: TwitchFragment): ChatMessage['fragments'][number] {
  if (f.type === 'emote' && f.emote) return { kind: 'emote', name: f.text, url: twitchEmoteUrl(f.emote.id, f.emote.format) };
  if (f.type === 'mention' && f.mention) return { kind: 'mention', name: f.mention.user_name };
  if (f.type === 'gif' && f.gif?.url) return { kind: 'emote', name: f.text, url: f.gif.url };
  return { kind: 'text', text: f.text };
}

export function normalizeTwitchMessage(
  event: TwitchChatEvent,
  messageTimestamp: string,
  now: () => number = Date.now,
): ChatMessage {
  const roles: Role[] = [];
  const add = (role: Role | undefined) => {
    if (role && !roles.includes(role)) roles.push(role);
  };
  if (event.chatter_user_id === event.broadcaster_user_id) add('owner');
  for (const badge of event.badges ?? []) add(BADGE_ROLES[badge.set_id]);

  return {
    id: `twitch:${event.message_id}`,
    platform: 'twitch',
    channel: event.broadcaster_user_login,
    author: {
      id: event.chatter_user_id,
      name: event.chatter_user_name,
      color: event.color || undefined,
      roles,
    },
    text: event.message.text,
    fragments: event.message.fragments.map(fragment),
    sentAt: parseTimestamp(messageTimestamp, now),
  };
}

export function normalizeTwitchDelete(event: { message_id: string }): { id: string } {
  return { id: `twitch:${event.message_id}` };
}

export function normalizeTwitchClear(event: { target_user_id?: string }): { platform: 'twitch'; authorId?: string } {
  return event.target_user_id ? { platform: 'twitch', authorId: event.target_user_id } : { platform: 'twitch' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/twitch/normalize.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "feat(hub): Twitch chat normalizer with documented fixtures"
```

---

### Task 5: Twitch EventSub connector

**Files:**
- Create: `apps/hub/src/connectors/types.ts`
- Create: `apps/hub/src/connectors/twitch/connector.ts`, `apps/hub/src/connectors/twitch/connector.test.ts`

**Interfaces:**
- Consumes: `Bus`; `backoffDelay`; `Timer`, `realTimer`, `describeError`; `FakeTimer`, `settle` (tests); `TwitchAuth` (`tokens`, `helix`, `validate`); the normalizers (Task 4).
- Produces:
  - `interface Connector { readonly platform: Platform; start(): void; stop(): Promise<void> }`
  - `type SocketLike = { onmessage: ((ev: { data: unknown }) => void) | null; onclose: ((ev: { code: number }) => void) | null; close(code?: number): void }`
  - `type SocketFactory = (url: string) => SocketLike`
  - `EVENTSUB_URL`, `TWITCH_SUBSCRIPTIONS` (the four types)
  - `class TwitchConnector implements Connector`:
    - `constructor(opts: { bus: Bus; auth: Pick<TwitchAuth, 'tokens' | 'helix' | 'validate'>; createSocket: SocketFactory; timer?: Timer; rand?: () => number; url?: string })`
    - Status events use source `'connector:twitch'`.
    - Keepalive watchdog = `keepalive_timeout_seconds * 1000 + 5000`.
    - Validation runs every `3_600_000` ms.

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/connectors/twitch/connector.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../../bus/bus';
import { FakeTimer, settle } from '../../testing/timer';
import type { SocketLike } from '../types';
import { TwitchConnector } from './connector';
import chatMessage from './fixtures/chat-message.json';
import messageDelete from './fixtures/message-delete.json';

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
}

const welcome = (id = 'SESSION1', keepalive = 10) => ({
  metadata: { message_id: `w-${id}`, message_type: 'session_welcome', message_timestamp: '2023-07-19T14:56:51.634234626Z' },
  payload: { session: { id, status: 'connected', connected_at: '2023-07-19T14:56:51Z', keepalive_timeout_seconds: keepalive, reconnect_url: null } },
});

let bus: Bus;
let timer: FakeTimer;
let sockets: FakeSocket[];
let events: Envelope[];
let helix: ReturnType<typeof vi.fn>;
let validate: ReturnType<typeof vi.fn>;
let tokens: { accessToken: string; refreshToken: string; userId: string; login: string } | undefined;
let connector: TwitchConnector;

beforeEach(() => {
  bus = new Bus();
  timer = new FakeTimer();
  sockets = [];
  events = [];
  tokens = { accessToken: 'a', refreshToken: 'r', userId: '1971641', login: 'streamer' };
  helix = vi.fn(async () => new Response(null, { status: 202 }));
  validate = vi.fn(async () => true);
  bus.subscribe(['chat.', 'platform.status'], (e) => events.push(e));
  connector = new TwitchConnector({
    bus,
    auth: { tokens: () => tokens, helix, validate } as never,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timer,
    rand: () => 1,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const statuses = () => events.filter((e) => e.type === 'platform.status').map((e) => e.payload);
const lastStatus = () => statuses().at(-1);
const ofType = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);

describe('TwitchConnector', () => {
  it('reports disconnected and opens nothing without tokens', () => {
    tokens = undefined;
    connector.start();
    expect(sockets).toHaveLength(0);
    expect(lastStatus()).toMatchObject({ platform: 'twitch', status: 'disconnected' });
  });

  it('subscribes to the four chat events on welcome, then goes live', async () => {
    connector.start();
    expect(sockets[0]!.url).toBe('wss://eventsub.wss.twitch.tv/ws');
    sockets[0]!.frame(welcome());
    await settle();
    const bodies = helix.mock.calls.map(([path, init]) => ({ path, body: JSON.parse((init as RequestInit).body as string) }));
    expect(bodies.map((b) => b.body.type)).toEqual([
      'channel.chat.message',
      'channel.chat.message_delete',
      'channel.chat.clear',
      'channel.chat.clear_user_messages',
    ]);
    expect(bodies[0]).toEqual({
      path: '/eventsub/subscriptions',
      body: {
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: '1971641', user_id: '1971641' },
        transport: { method: 'websocket', session_id: 'SESSION1' },
      },
    });
    expect(lastStatus()).toMatchObject({ status: 'live' });
  });

  it('treats 409 (already subscribed) as success', async () => {
    helix.mockImplementation(async () => new Response(null, { status: 409 }));
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'live' });
  });

  it('publishes chat, deletes and clears, ignoring duplicate deliveries', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    sockets[0]!.frame(chatMessage);
    sockets[0]!.frame(chatMessage);
    sockets[0]!.frame(messageDelete);
    sockets[0]!.frame({
      metadata: { message_id: 'c1', message_type: 'notification', message_timestamp: '2023-01-01T00:00:00Z', subscription_type: 'channel.chat.clear_user_messages' },
      payload: { event: { broadcaster_user_id: '1', target_user_id: '7734' } },
    });
    expect(ofType('chat.message')).toHaveLength(1);
    expect(ofType('chat.message')[0]).toMatchObject({ id: 'twitch:cc106a89-1814-919d-454c-f4f2f970aae7', text: 'Hi chat' });
    expect(ofType('chat.deleted')).toEqual([{ id: 'twitch:ab24e0b0-2260-4bac-94e4-05eedd4ecd0e' }]);
    expect(ofType('chat.cleared')).toEqual([{ platform: 'twitch', authorId: '7734' }]);
  });

  it('ignores malformed frames', async () => {
    connector.start();
    sockets[0]!.onmessage?.({ data: 'not json {' });
    sockets[0]!.frame({ nonsense: true });
    sockets[0]!.frame(welcome());
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'live' });
  });

  it('reports a failed subscription and reconnects with backoff', async () => {
    helix.mockImplementation(async () => new Response(null, { status: 403 }));
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('403') });
    expect(sockets[0]!.closed).toBe(true);
    timer.fire(1000);
    expect(sockets).toHaveLength(2);
  });

  it('reconnects and resubscribes after keepalive silence', async () => {
    connector.start();
    sockets[0]!.frame(welcome('S1', 10));
    await settle();
    timer.fire(15_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(lastStatus()).toMatchObject({ status: 'connecting', detail: expect.stringContaining('keepalive') });
    timer.fire(1000);
    sockets[1]!.frame(welcome('S2'));
    await settle();
    expect(helix.mock.calls.filter(([, init]) => (init as RequestInit).body!.toString().includes('S2'))).toHaveLength(4);
  });

  it('hands over to the reconnect url without resubscribing', async () => {
    connector.start();
    sockets[0]!.frame(welcome('S1'));
    await settle();
    helix.mockClear();
    sockets[0]!.frame({
      metadata: { message_id: 'r1', message_type: 'session_reconnect', message_timestamp: '2022-11-18T09:10:11Z' },
      payload: { session: { id: 'S1', status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: 'wss://eventsub.wss.twitch.tv?reconnect=1', connected_at: '2022-11-16T10:11:12Z' } },
    });
    expect(sockets[1]!.url).toBe('wss://eventsub.wss.twitch.tv?reconnect=1');
    expect(sockets[0]!.closed).toBe(false);
    sockets[0]!.frame(chatMessage); // old socket still delivers until the new welcome
    sockets[1]!.frame(welcome('S1'));
    await settle();
    expect(sockets[0]!.closed).toBe(true);
    expect(helix).not.toHaveBeenCalled();
    sockets[0]!.drop(1000); // closing the old socket must not trigger a reconnect
    expect(timer.has(1000)).toBe(false);
    expect(ofType('chat.message')).toHaveLength(1);
  });

  it('reconnects after an unexpected close', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    sockets[0]!.drop(4006);
    expect(lastStatus()).toMatchObject({ status: 'connecting', detail: expect.stringContaining('4006') });
    timer.fire(1000);
    expect(sockets).toHaveLength(2);
  });

  it('stops with a reconnect hint when authorization is revoked', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    sockets[0]!.frame({
      metadata: { message_id: 'v1', message_type: 'revocation', message_timestamp: '2022-11-16T10:11:12Z', subscription_type: 'channel.chat.message' },
      payload: { subscription: { type: 'channel.chat.message', status: 'authorization_revoked' } },
    });
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('Connections') });
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop(1000);
    expect(timer.has(1000)).toBe(false);
  });

  it('validates hourly and stops when the login is dead', async () => {
    connector.start();
    await settle();
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockResolvedValue(false);
    timer.fire(3_600_000);
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('Reconnect Twitch') });
  });

  it('stop closes the socket and prevents reconnects', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    await connector.stop();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop(1006);
    expect(timer.queue).toEqual([]);
    expect(lastStatus()).toMatchObject({ status: 'disconnected' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/twitch/connector.test.ts`
Expected: FAIL, `../types` and `./connector` not found.

- [ ] **Step 3: Implement**

`apps/hub/src/connectors/types.ts`:
```ts
import type { Platform } from '@streamhub/shared';

export interface Connector {
  readonly platform: Platform;
  start(): void;
  stop(): Promise<void>;
}

/** The subset of a WebSocket client we use (the `ws` package satisfies it via a cast). */
export type SocketLike = {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  close(code?: number): void;
};

export type SocketFactory = (url: string) => SocketLike;
```

`apps/hub/src/connectors/twitch/connector.ts`:
```ts
import type { ConnectorStatus, EventPayload, KnownEventType } from '@streamhub/shared';
import type { Bus } from '../../bus/bus';
import { backoffDelay } from '../../util/backoff';
import { describeError } from '../../util/errors';
import { realTimer, type Timer } from '../../util/timer';
import type { Connector, SocketFactory, SocketLike } from '../types';
import type { TwitchAuth } from './auth';
import {
  normalizeTwitchClear,
  normalizeTwitchDelete,
  normalizeTwitchMessage,
  type TwitchChatEvent,
} from './normalize';

export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
export const TWITCH_SUBSCRIPTIONS = [
  'channel.chat.message',
  'channel.chat.message_delete',
  'channel.chat.clear',
  'channel.chat.clear_user_messages',
] as const;

const KEEPALIVE_GRACE_MS = 5000;
const VALIDATE_EVERY_MS = 60 * 60 * 1000;
const SEEN_LIMIT = 1000;
const RECONNECT_HINT = 'Reconnect Twitch on the Connections page.';

type Frame = {
  metadata?: { message_id?: string; message_type?: string; message_timestamp?: string; subscription_type?: string };
  payload?: {
    session?: { id: string; keepalive_timeout_seconds: number | null; reconnect_url: string | null };
    subscription?: { type?: string; status?: string };
    event?: unknown;
  };
};

export type TwitchConnectorOptions = {
  bus: Bus;
  auth: Pick<TwitchAuth, 'tokens' | 'helix' | 'validate'>;
  createSocket: SocketFactory;
  timer?: Timer;
  rand?: () => number;
  url?: string;
};

/** EventSub WebSocket lifecycle. See docs/connectors/twitch.md §3. */
export class TwitchConnector implements Connector {
  readonly platform = 'twitch' as const;
  private socket: SocketLike | null = null;
  private handover: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: unknown = null;
  private watchdog: unknown = null;
  private validation: unknown = null;
  private keepaliveMs = 10_000;
  private readonly seen = new Set<string>();
  private readonly timer: Timer;
  private readonly rand: () => number;

  constructor(private readonly opts: TwitchConnectorOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
  }

  start() {
    this.stopped = false;
    if (!this.opts.auth.tokens()) {
      this.status('disconnected', 'Connect Twitch on the Connections page');
      return;
    }
    this.open(this.opts.url ?? EVENTSUB_URL, false);
    void this.checkToken();
  }

  async stop() {
    this.shutdown();
    this.status('disconnected');
  }

  private shutdown() {
    this.stopped = true;
    for (const handle of [this.retry, this.watchdog, this.validation]) if (handle !== null) this.timer.clear(handle);
    this.retry = this.watchdog = this.validation = null;
    const sockets = [this.socket, this.handover];
    this.socket = this.handover = null;
    sockets.forEach((s) => s?.close(1000));
  }

  private halt(detail: string) {
    this.shutdown();
    this.status('error', detail);
  }

  private open(url: string, isHandover: boolean) {
    if (!isHandover) this.status('connecting');
    const socket = this.opts.createSocket(url);
    if (isHandover) this.handover = this.socket;
    this.socket = socket;
    socket.onmessage = (ev) => this.onFrame(socket, String(ev.data));
    socket.onclose = (ev) => this.onSocketClosed(socket, ev.code);
  }

  private onFrame(socket: SocketLike, text: string) {
    if (socket !== this.socket && socket !== this.handover) return;
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if (socket === this.socket) this.armWatchdog();
    switch (frame.metadata?.message_type) {
      case 'session_welcome':
        void this.onWelcome(socket, frame);
        return;
      case 'notification':
        this.onNotification(frame);
        return;
      case 'session_reconnect': {
        const url = frame.payload?.session?.reconnect_url;
        if (url && socket === this.socket) this.open(url, true);
        return;
      }
      case 'revocation':
        this.onRevocation(frame);
        return;
    }
  }

  private async onWelcome(socket: SocketLike, frame: Frame) {
    const session = frame.payload?.session;
    if (!session || socket !== this.socket) return;
    this.keepaliveMs = (session.keepalive_timeout_seconds ?? 10) * 1000;
    this.armWatchdog();
    if (this.handover) {
      // Subscriptions carry over to the reconnect socket.
      const old = this.handover;
      this.handover = null;
      old.close(1000);
      return;
    }
    try {
      await this.subscribeAll(session.id);
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.status('live');
    } catch (err) {
      if (socket !== this.socket) return;
      this.status('error', describeError(err));
      this.dropSocket();
      this.scheduleReconnect();
    }
  }

  private async subscribeAll(sessionId: string) {
    const userId = this.opts.auth.tokens()?.userId;
    if (!userId) throw new Error('Twitch is not connected');
    for (const type of TWITCH_SUBSCRIPTIONS) {
      const res = await this.opts.auth.helix('/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          version: '1',
          condition: { broadcaster_user_id: userId, user_id: userId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });
      if (res.status !== 202 && res.status !== 409) {
        throw new Error(`Subscribing to ${type} failed (${res.status})`);
      }
    }
  }

  private onNotification(frame: Frame) {
    const id = frame.metadata?.message_id;
    const event = frame.payload?.event as Record<string, unknown> | undefined;
    if (!id || !event || this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);

    switch (frame.metadata?.subscription_type) {
      case 'channel.chat.message':
        this.publish(
          'chat.message',
          normalizeTwitchMessage(event as unknown as TwitchChatEvent, frame.metadata.message_timestamp ?? ''),
        );
        return;
      case 'channel.chat.message_delete':
        this.publish('chat.deleted', normalizeTwitchDelete(event as { message_id: string }));
        return;
      case 'channel.chat.clear':
      case 'channel.chat.clear_user_messages':
        this.publish('chat.cleared', normalizeTwitchClear(event as { target_user_id?: string }));
        return;
    }
  }

  private onRevocation(frame: Frame) {
    const sub = frame.payload?.subscription;
    if (sub?.status === 'authorization_revoked' || sub?.status === 'user_removed') {
      this.halt(`Twitch access was revoked. ${RECONNECT_HINT}`);
      return;
    }
    console.warn(`[twitch] subscription ${sub?.type} revoked: ${sub?.status}`);
  }

  private onSocketClosed(socket: SocketLike, code: number) {
    if (socket === this.handover) {
      this.handover = null;
      return;
    }
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearWatchdog();
    if (this.stopped) return;
    this.status('connecting', `Twitch closed the connection (${code})`);
    this.scheduleReconnect();
  }

  private dropSocket() {
    const s = this.socket;
    this.socket = null;
    this.clearWatchdog();
    s?.close(1000);
  }

  private armWatchdog() {
    this.clearWatchdog();
    this.watchdog = this.timer.set(() => {
      this.watchdog = null;
      if (this.stopped) return;
      this.status('connecting', 'Twitch keepalive timed out');
      this.dropSocket();
      this.scheduleReconnect();
    }, this.keepaliveMs + KEEPALIVE_GRACE_MS);
  }

  private clearWatchdog() {
    if (this.watchdog !== null) this.timer.clear(this.watchdog);
    this.watchdog = null;
  }

  private scheduleReconnect() {
    if (this.stopped || this.retry !== null) return;
    this.retry = this.timer.set(() => {
      this.retry = null;
      if (!this.stopped) this.open(this.opts.url ?? EVENTSUB_URL, false);
    }, backoffDelay(this.attempt++, this.rand));
  }

  private async checkToken() {
    const ok = await this.opts.auth.validate().catch(() => false);
    if (this.stopped) return;
    if (!ok) {
      this.halt(`Twitch login expired. ${RECONNECT_HINT}`);
      return;
    }
    this.validation = this.timer.set(() => {
      this.validation = null;
      if (!this.stopped) void this.checkToken();
    }, VALIDATE_EVERY_MS);
  }

  private status(status: ConnectorStatus, detail?: string) {
    this.publish('platform.status', { platform: 'twitch', status, ...(detail ? { detail } : {}) });
  }

  private publish<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    const result = this.opts.bus.publish({ type, payload, source: 'connector:twitch' });
    if (!result.ok) console.warn(`[twitch] dropped invalid ${type}: ${result.error}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/twitch && pnpm typecheck && pnpm lint`
Expected: PASS (12 connector tests plus the earlier Twitch tests).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): Twitch EventSub connector with keepalive, handover, revocation and hourly validation"
```

---

### Task 6: YouTube auth (BYO client, loopback OAuth with PKCE)

**Files:**
- Create: `apps/hub/src/connectors/youtube/auth.ts`, `apps/hub/src/connectors/youtube/auth.test.ts`

**Interfaces:**
- Consumes: `SecretsStore` (Task 2); `fakeFetch`, `json` (tests).
- Produces:
  - `YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'`
  - `class YouTubeAuthError extends Error`
  - `interface TokenSource { accessToken(): Promise<string>; invalidate(): void }`
  - `class YouTubeAuth implements TokenSource`:
    - `constructor(opts: { store: SecretsStore; redirectUri: string; fetchFn?: typeof fetch; now?: () => number; random?: (bytes: number) => Buffer })`
    - `clientConfigured(): boolean`, `connected(): boolean`, `account(): string | undefined`
    - `setClient(clientId: string, clientSecret: string): Promise<void>`, `setAccount(channelTitle: string | undefined): Promise<void>`
    - `beginAuth(): string` (returns the Google sign-in URL)
    - `completeAuth(query: { code?: string; state?: string; error?: string }): Promise<void>`
    - `accessToken(): Promise<string>`, `invalidate(): void`, `clearTokens(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/connectors/youtube/auth.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretsStore } from '../../secrets/store';
import { fakeFetch, json } from '../../testing/http';
import { YouTubeAuth, YouTubeAuthError } from './auth';

const REDIRECT = 'http://127.0.0.1:4747/oauth/youtube/callback';
let store: SecretsStore;
let t: number;
beforeEach(async () => {
  store = new SecretsStore(join(await mkdtemp(join(tmpdir(), 'yt-auth-')), 'secrets.json'));
  t = 1_000_000;
});

const make = (fetchFn = fakeFetch(() => json(500, {}))) =>
  new YouTubeAuth({ store, redirectUri: REDIRECT, fetchFn, now: () => t, random: (n) => Buffer.alloc(n, 7) });

describe('YouTubeAuth', () => {
  it('requires a client before sign-in', () => {
    expect(() => make().beginAuth()).toThrow(YouTubeAuthError);
  });

  it('stores a trimmed client and builds a PKCE sign-in url', async () => {
    const auth = make();
    await auth.setClient('  cid.apps.googleusercontent.com ', ' secret ');
    expect(auth.clientConfigured()).toBe(true);
    expect(store.get().youtube).toEqual({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' });
    const url = new URL(auth.beginAuth());
    const verifier = Buffer.alloc(48, 7).toString('base64url');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid.apps.googleusercontent.com',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: Buffer.alloc(16, 7).toString('base64url'),
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('rejects a callback with the wrong state', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    auth.beginAuth();
    await expect(auth.completeAuth({ code: 'c', state: 'forged' })).rejects.toThrow('invalid or expired');
  });

  it('rejects a callback after the sign-in window', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    t += 11 * 60 * 1000;
    await expect(auth.completeAuth({ code: 'c', state })).rejects.toThrow('invalid or expired');
  });

  it('reports a Google error from the callback', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    auth.beginAuth();
    await expect(auth.completeAuth({ error: 'access_denied' })).rejects.toThrow('access_denied');
  });

  it('exchanges the code with the verifier and stores tokens', async () => {
    const fetchFn = fakeFetch(() => json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
    const auth = make(fetchFn);
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    await auth.completeAuth({ code: 'the-code', state });
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: Buffer.alloc(48, 7).toString('base64url'),
      redirect_uri: REDIRECT,
      client_id: 'cid',
      client_secret: 'secret',
    });
    expect(store.get().youtube).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: t + 3_600_000 });
    expect(auth.connected()).toBe(true);
    // A state can only be used once.
    await expect(auth.completeAuth({ code: 'again', state })).rejects.toThrow('invalid or expired');
  });

  it('uses the cached token, refreshes near expiry and after invalidate', async () => {
    const fetchFn = fakeFetch(() => json(200, { access_token: 'fresh', expires_in: 3600 }));
    const auth = make(fetchFn);
    await store.update((s) => ({ ...s, youtube: { clientId: 'cid', clientSecret: 's', accessToken: 'cached', refreshToken: 'rt', expiresAt: t + 600_000 } }));
    expect(await auth.accessToken()).toBe('cached');
    auth.invalidate();
    expect(await auth.accessToken()).toBe('fresh');
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'cid', client_secret: 's' });
    t += 3_600_000 - 30_000; // within 60 s of expiry
    await auth.accessToken();
    expect(fetchFn.calls).toHaveLength(2);
  });

  it('clears tokens and asks to reconnect when Google says invalid_grant', async () => {
    const auth = make(fakeFetch(() => json(400, { error: 'invalid_grant' })));
    await store.update((s) => ({ ...s, youtube: { clientId: 'cid', clientSecret: 's', refreshToken: 'rt' } }));
    await expect(auth.accessToken()).rejects.toThrow('Reconnect YouTube');
    expect(store.get().youtube).toEqual({ clientId: 'cid', clientSecret: 's' });
    expect(auth.connected()).toBe(false);
  });

  it('throws when not connected', async () => {
    await expect(make().accessToken()).rejects.toBeInstanceOf(YouTubeAuthError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/auth.test.ts`
Expected: FAIL, `./auth` not found.

- [ ] **Step 3: Implement**

`apps/hub/src/connectors/youtube/auth.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { SecretsStore } from '../../secrets/store';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60_000;
const RECONNECT = 'YouTube sign-in expired. Reconnect YouTube on the Connections page.';

export class YouTubeAuthError extends Error {}

export interface TokenSource {
  accessToken(): Promise<string>;
  invalidate(): void;
}

type Options = {
  store: SecretsStore;
  redirectUri: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  random?: (bytes: number) => Buffer;
};

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string };

/** Loopback OAuth + PKCE with the streamer's own Desktop client. See docs/connectors/youtube.md "Auth". */
export class YouTubeAuth implements TokenSource {
  private pending: { state: string; verifier: string; expiresAt: number } | null = null;
  private stale = false;
  private refreshing: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;

  constructor(private readonly opts: Options) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? randomBytes;
  }

  clientConfigured(): boolean {
    return Boolean(this.opts.store.get().youtube?.clientId);
  }

  connected(): boolean {
    return Boolean(this.opts.store.get().youtube?.refreshToken);
  }

  account(): string | undefined {
    return this.opts.store.get().youtube?.channelTitle;
  }

  /** Saving a new client drops any tokens issued to the previous one. */
  async setClient(clientId: string, clientSecret: string): Promise<void> {
    await this.opts.store.update((s) => ({
      ...s,
      youtube: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
    }));
  }

  async setAccount(channelTitle: string | undefined): Promise<void> {
    await this.opts.store.update((s) => (s.youtube ? { ...s, youtube: { ...s.youtube, channelTitle } } : s));
  }

  beginAuth(): string {
    const yt = this.opts.store.get().youtube;
    if (!yt?.clientId) throw new YouTubeAuthError('Add your Google OAuth client first (see docs/setup/youtube.md).');
    const verifier = this.random(48).toString('base64url');
    const state = this.random(16).toString('base64url');
    this.pending = { state, verifier, expiresAt: this.now() + SIGN_IN_WINDOW_MS };
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: yt.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    return url.toString();
  }

  async completeAuth(query: { code?: string; state?: string; error?: string }): Promise<void> {
    const pending = this.pending;
    if (query.error) {
      this.pending = null;
      throw new YouTubeAuthError(`Google sign-in failed: ${query.error}`);
    }
    if (!pending || query.state !== pending.state || this.now() > pending.expiresAt || !query.code) {
      throw new YouTubeAuthError('This sign-in link is invalid or expired. Start again from the Connections page.');
    }
    this.pending = null;
    const yt = this.opts.store.get().youtube;
    if (!yt) throw new YouTubeAuthError('Add your Google OAuth client first (see docs/setup/youtube.md).');
    const body = await this.token({
      grant_type: 'authorization_code',
      code: query.code,
      code_verifier: pending.verifier,
      redirect_uri: this.opts.redirectUri,
      client_id: yt.clientId,
      client_secret: yt.clientSecret,
    });
    if (!body.refresh_token) {
      throw new YouTubeAuthError(
        'Google did not return a refresh token. Remove streamhub at myaccount.google.com/permissions and connect again.',
      );
    }
    this.stale = false;
    await this.opts.store.update((s) => ({
      ...s,
      youtube: {
        ...yt,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: this.now() + body.expires_in * 1000,
      },
    }));
  }

  async accessToken(): Promise<string> {
    const yt = this.opts.store.get().youtube;
    if (!yt?.refreshToken) throw new YouTubeAuthError('YouTube is not connected. Connect it on the Connections page.');
    if (!this.stale && yt.accessToken && yt.expiresAt && yt.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return yt.accessToken;
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  invalidate(): void {
    this.stale = true;
  }

  async clearTokens(): Promise<void> {
    await this.opts.store.update((s) =>
      s.youtube ? { ...s, youtube: { clientId: s.youtube.clientId, clientSecret: s.youtube.clientSecret } } : s,
    );
  }

  private async refresh(): Promise<string> {
    const yt = this.opts.store.get().youtube;
    if (!yt?.refreshToken) throw new YouTubeAuthError('YouTube is not connected. Connect it on the Connections page.');
    let body: TokenResponse;
    try {
      body = await this.token({
        grant_type: 'refresh_token',
        refresh_token: yt.refreshToken,
        client_id: yt.clientId,
        client_secret: yt.clientSecret,
      });
    } catch (err) {
      if (err instanceof YouTubeAuthError && err.message.includes('invalid_grant')) {
        await this.clearTokens();
        throw new YouTubeAuthError(RECONNECT);
      }
      throw err;
    }
    this.stale = false;
    await this.opts.store.update((s) =>
      s.youtube
        ? { ...s, youtube: { ...s.youtube, accessToken: body.access_token, expiresAt: this.now() + body.expires_in * 1000 } }
        : s,
    );
    return body.access_token;
  }

  private async token(form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new YouTubeAuthError(`Google token request failed: ${String(body.error ?? res.status)}`);
    return body as unknown as TokenResponse;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/auth.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): YouTube loopback OAuth with PKCE for bring-your-own Google clients"
```

---

### Task 7: YouTube normalizer

**Files:**
- Create: `apps/hub/src/connectors/youtube/normalize.ts`, `apps/hub/src/connectors/youtube/normalize.test.ts`

**Interfaces:**
- Produces:
  - `type YtAuthor = { channelId?: string; displayName?: string; profileImageUrl?: string; isChatOwner?: boolean; isChatModerator?: boolean; isChatSponsor?: boolean }`
  - `type YtMessage = { id?: string; snippet?: { type?: string; publishedAt?: string; authorChannelId?: string; displayMessage?: string; textMessageDetails?: { messageText?: string }; userBannedDetails?: { bannedUserDetails?: { channelId?: string } } }; authorDetails?: YtAuthor }`
  - `type YtListResponse = { nextPageToken?: string; pollingIntervalMillis?: number; offlineAt?: string; items?: YtMessage[] }`
  - `type YtNormalized = { kind: 'message'; message: ChatMessage } | { kind: 'deleted'; id: string } | { kind: 'cleared'; authorId: string } | { kind: 'ended' }`
  - `normalizeYouTubeItem(item: YtMessage, channel: string, now?: () => number): YtNormalized | null`
  - `grpcTypeToRest(type: string): string`
  - `fromGrpcResponse(r: YtListResponse): YtListResponse` (proto-loader output has camelCase fields like REST, but enum-string types)

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/connectors/youtube/normalize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ChatMessageSchema } from '@streamhub/shared';
import { fromGrpcResponse, grpcTypeToRest, normalizeYouTubeItem, type YtMessage } from './normalize';

const now = () => 99;

// Shaped after the liveChatMessage resource in docs/connectors/youtube.md.
const text: YtMessage = {
  id: 'LCC.abc',
  snippet: {
    type: 'textMessageEvent',
    publishedAt: '2026-10-01T12:00:00.123Z',
    authorChannelId: 'UCviewer',
    displayMessage: 'hello <b>yt</b> 👋',
    textMessageDetails: { messageText: 'hello <b>yt</b> 👋' },
  },
  authorDetails: {
    channelId: 'UCviewer',
    displayName: 'Viewer',
    profileImageUrl: 'https://yt3.ggpht.com/a.jpg',
    isChatOwner: false,
    isChatModerator: true,
    isChatSponsor: true,
  },
};

describe('normalizeYouTubeItem', () => {
  it('maps a text message', () => {
    const r = normalizeYouTubeItem(text, 'My Channel', now);
    expect(r).toEqual({
      kind: 'message',
      message: {
        id: 'youtube:LCC.abc',
        platform: 'youtube',
        channel: 'My Channel',
        author: { id: 'UCviewer', name: 'Viewer', avatarUrl: 'https://yt3.ggpht.com/a.jpg', roles: ['moderator', 'member'] },
        text: 'hello <b>yt</b> 👋',
        fragments: [{ kind: 'text', text: 'hello <b>yt</b> 👋' }],
        sentAt: Date.parse('2026-10-01T12:00:00.123Z'),
      },
    });
    if (r?.kind === 'message') expect(ChatMessageSchema.safeParse(r.message).success).toBe(true);
  });

  it('maps the chat owner and uses displayMessage for paid events', () => {
    const r = normalizeYouTubeItem(
      { id: 'sc1', snippet: { type: 'superChatEvent', publishedAt: '2026-10-01T12:00:00Z', displayMessage: '$5.00 from Fan: "gg"' }, authorDetails: { channelId: 'UCfan', displayName: 'Fan', isChatOwner: true } },
      'c',
      now,
    );
    expect(r).toMatchObject({ kind: 'message', message: { text: '$5.00 from Fan: "gg"', author: { roles: ['owner'] } } });
  });

  it('maps tombstones, bans and chat end', () => {
    expect(normalizeYouTubeItem({ id: 'x1', snippet: { type: 'tombstone' } }, 'c')).toEqual({ kind: 'deleted', id: 'youtube:x1' });
    expect(
      normalizeYouTubeItem({ id: 'b1', snippet: { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { channelId: 'UCbad' } } } }, 'c'),
    ).toEqual({ kind: 'cleared', authorId: 'UCbad' });
    expect(normalizeYouTubeItem({ id: 'e1', snippet: { type: 'chatEndedEvent' } }, 'c')).toEqual({ kind: 'ended' });
  });

  it('ignores unknown types, polls and items without id', () => {
    expect(normalizeYouTubeItem({ id: 'p1', snippet: { type: 'pollEvent', displayMessage: 'poll' } }, 'c')).toBeNull();
    expect(normalizeYouTubeItem({ snippet: { type: 'textMessageEvent', displayMessage: 'x' } }, 'c')).toBeNull();
    expect(normalizeYouTubeItem({ id: 'q', snippet: { type: 'sponsorOnlyModeStartedEvent' } }, 'c')).toBeNull();
  });

  it('falls back to now and placeholders for missing fields', () => {
    const r = normalizeYouTubeItem({ id: 'm', snippet: { type: 'textMessageEvent', displayMessage: 'hi' } }, 'c', now);
    expect(r).toMatchObject({ message: { sentAt: 99, author: { id: 'unknown', name: 'YouTube user', roles: [] } } });
  });
});

describe('gRPC mapping', () => {
  it('converts proto enum names to REST type names', () => {
    expect(grpcTypeToRest('TEXT_MESSAGE_EVENT')).toBe('textMessageEvent');
    expect(grpcTypeToRest('TOMBSTONE')).toBe('tombstone');
    expect(grpcTypeToRest('GIFT_MEMBERSHIP_RECEIVED_EVENT')).toBe('giftMembershipReceivedEvent');
  });

  it('maps a stream response so the REST normalizer can read it', () => {
    const r = fromGrpcResponse({
      nextPageToken: 'tok',
      items: [{ ...text, snippet: { ...text.snippet, type: 'TEXT_MESSAGE_EVENT' } }],
    });
    expect(r.nextPageToken).toBe('tok');
    expect(normalizeYouTubeItem(r.items![0]!, 'c', now)).toMatchObject({ kind: 'message' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/normalize.test.ts`
Expected: FAIL, `./normalize` not found.

- [ ] **Step 3: Implement**

`apps/hub/src/connectors/youtube/normalize.ts`:
```ts
import type { ChatMessage } from '@streamhub/shared';

export type YtAuthor = {
  channelId?: string;
  displayName?: string;
  profileImageUrl?: string;
  isChatOwner?: boolean;
  isChatModerator?: boolean;
  isChatSponsor?: boolean;
};

export type YtMessage = {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    authorChannelId?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
    userBannedDetails?: { bannedUserDetails?: { channelId?: string } };
  };
  authorDetails?: YtAuthor;
};

export type YtListResponse = {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items?: YtMessage[];
};

export type YtNormalized =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'deleted'; id: string }
  | { kind: 'cleared'; authorId: string }
  | { kind: 'ended' };

/** Types shown in the chat feed. YouTube gives plain text only (no emote images). */
const CHAT_TYPES = new Set([
  'textMessageEvent',
  'superChatEvent',
  'superStickerEvent',
  'memberMilestoneChatEvent',
  'newSponsorEvent',
  'membershipGiftingEvent',
  'giftMembershipReceivedEvent',
]);

type Role = ChatMessage['author']['roles'][number];

export function normalizeYouTubeItem(
  item: YtMessage,
  channel: string,
  now: () => number = Date.now,
): YtNormalized | null {
  const type = item.snippet?.type;
  if (!item.id || !type) return null;
  if (type === 'chatEndedEvent') return { kind: 'ended' };
  // Best effort: YouTube stopped reporting deletions (2026-06-23); a tombstone may share the deleted id.
  if (type === 'tombstone') return { kind: 'deleted', id: `youtube:${item.id}` };
  if (type === 'userBannedEvent') {
    const authorId = item.snippet?.userBannedDetails?.bannedUserDetails?.channelId;
    return authorId ? { kind: 'cleared', authorId } : null;
  }
  if (!CHAT_TYPES.has(type)) return null;

  const text = item.snippet?.textMessageDetails?.messageText ?? item.snippet?.displayMessage ?? '';
  if (!text) return null;
  const a = item.authorDetails ?? {};
  const roles: Role[] = [];
  if (a.isChatOwner) roles.push('owner');
  if (a.isChatModerator) roles.push('moderator');
  if (a.isChatSponsor) roles.push('member');
  const sentAt = Date.parse(item.snippet?.publishedAt ?? '');

  return {
    kind: 'message',
    message: {
      id: `youtube:${item.id}`,
      platform: 'youtube',
      channel,
      author: {
        id: a.channelId ?? item.snippet?.authorChannelId ?? 'unknown',
        name: a.displayName ?? 'YouTube user',
        avatarUrl: a.profileImageUrl,
        roles,
      },
      text,
      fragments: [{ kind: 'text', text }],
      sentAt: Number.isNaN(sentAt) ? now() : sentAt,
    },
  };
}

/** `TEXT_MESSAGE_EVENT` → `textMessageEvent`. */
export function grpcTypeToRest(type: string): string {
  return type.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** proto-loader (keepCase: false) already yields REST-style camelCase fields; only the enum differs. */
export function fromGrpcResponse(r: YtListResponse): YtListResponse {
  return {
    ...r,
    items: r.items?.map((item) =>
      item.snippet?.type ? { ...item, snippet: { ...item.snippet, type: grpcTypeToRest(item.snippet.type) } } : item,
    ),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/normalize.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): YouTube chat normalizer and gRPC response mapping"
```

---

### Task 8: YouTube API client (REST + gRPC streamList)

**Files:**
- Create: `apps/hub/src/connectors/youtube/stream_list.proto` (copy of `docs/connectors/youtube-stream_list.proto`)
- Create: `apps/hub/src/connectors/youtube/api.ts`, `apps/hub/src/connectors/youtube/api.test.ts`

**Interfaces:**
- Consumes: `YtListResponse`, `fromGrpcResponse` (Task 7); `fakeFetch`, `json` (tests).
- Produces:
  - `class YouTubeApiError extends Error { readonly kind: 'auth' | 'ended' | 'rate' | 'other' }`
  - `type StreamHandlers = { onResponse(r: YtListResponse): void; onError(err: YouTubeApiError): void; onEnd(): void }`
  - `type ChatStream = { cancel(): void }`
  - `interface YouTubeApi`:
    - `findActiveChat(token: string): Promise<{ liveChatId: string; title: string } | null>`
    - `myChannelTitle(token: string): Promise<string | undefined>`
    - `pollChat(token: string, liveChatId: string, pageToken?: string): Promise<YtListResponse>`
    - `streamChat(token: string, liveChatId: string, pageToken: string | undefined, handlers: StreamHandlers): ChatStream`
  - `createYouTubeApi(fetchFn?: typeof fetch): YouTubeApi`
  - `mapGrpcError(err: { code?: number; details?: string; message?: string }): YouTubeApiError`
  - `loadStreamListService(): grpc.ServiceClientConstructor`

- [ ] **Step 1: Add the proto and the dependencies**

```bash
cp docs/connectors/youtube-stream_list.proto apps/hub/src/connectors/youtube/stream_list.proto
pnpm --filter @streamhub/hub add @grpc/grpc-js @grpc/proto-loader
```

- [ ] **Step 2: Write the failing tests**

`apps/hub/src/connectors/youtube/api.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../testing/http';
import { createYouTubeApi, loadStreamListService, mapGrpcError, YouTubeApiError } from './api';

const googleError = (status: number, reason: string) =>
  json(status, { error: { code: status, message: `reason ${reason}`, errors: [{ reason }] } });

describe('findActiveChat', () => {
  it('asks for the active broadcast of any type and returns its chat id', async () => {
    const fetchFn = fakeFetch(() => json(200, { items: [{ id: 'vid', snippet: { title: 'Show #1', liveChatId: 'CHAT' } }] }));
    const api = createYouTubeApi(fetchFn);
    expect(await api.findActiveChat('tok')).toEqual({ liveChatId: 'CHAT', title: 'Show #1' });
    const url = new URL(fetchFn.calls[0]!.url);
    expect(url.pathname).toBe('/youtube/v3/liveBroadcasts');
    expect(Object.fromEntries(url.searchParams)).toEqual({ part: 'snippet', broadcastStatus: 'active', broadcastType: 'all' });
    expect((fetchFn.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns null when nothing is live', async () => {
    expect(await createYouTubeApi(fakeFetch(() => json(200, { items: [] }))).findActiveChat('t')).toBeNull();
  });

  it('classifies an expired token as an auth error', async () => {
    const api = createYouTubeApi(fakeFetch(() => googleError(401, 'authError')));
    await expect(api.findActiveChat('t')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('classifies quota exhaustion as a rate error', async () => {
    const api = createYouTubeApi(fakeFetch(() => googleError(403, 'quotaExceeded')));
    await expect(api.findActiveChat('t')).rejects.toMatchObject({ kind: 'rate' });
  });
});

describe('pollChat', () => {
  it('requests snippet and authorDetails with the page token', async () => {
    const fetchFn = fakeFetch(() => json(200, { nextPageToken: 'n2', pollingIntervalMillis: 3000, items: [] }));
    const r = await createYouTubeApi(fetchFn).pollChat('t', 'CHAT', 'n1');
    expect(r).toMatchObject({ nextPageToken: 'n2', pollingIntervalMillis: 3000 });
    const url = new URL(fetchFn.calls[0]!.url);
    expect(url.pathname).toBe('/youtube/v3/liveChat/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ liveChatId: 'CHAT', part: 'snippet,authorDetails', pageToken: 'n1' });
  });

  it('classifies an ended chat', async () => {
    const api = createYouTubeApi(fakeFetch(() => googleError(403, 'liveChatEnded')));
    await expect(api.pollChat('t', 'CHAT')).rejects.toMatchObject({ kind: 'ended' });
  });
});

describe('myChannelTitle', () => {
  it('reads the authenticated channel title', async () => {
    const fetchFn = fakeFetch(() => json(200, { items: [{ snippet: { title: 'Your Average Tech Founder' } }] }));
    expect(await createYouTubeApi(fetchFn).myChannelTitle('t')).toBe('Your Average Tech Founder');
    expect(new URL(fetchFn.calls[0]!.url).searchParams.get('mine')).toBe('true');
  });
});

describe('gRPC', () => {
  it('loads the published streamList service definition', () => {
    const service = loadStreamListService();
    expect(service.service.StreamList!.path).toBe('/youtube.api.v3.V3DataLiveChatMessageService/StreamList');
    expect(service.service.StreamList!.responseStream).toBe(true);
  });

  it('maps gRPC status codes', () => {
    expect(mapGrpcError({ code: 16, details: 'bad token' }).kind).toBe('auth');
    expect(mapGrpcError({ code: 9, details: 'chat ended' }).kind).toBe('ended');
    expect(mapGrpcError({ code: 5 }).kind).toBe('ended');
    expect(mapGrpcError({ code: 8 }).kind).toBe('rate');
    expect(mapGrpcError({ code: 14, details: 'unavailable' })).toBeInstanceOf(YouTubeApiError);
    expect(mapGrpcError({ code: 14 }).kind).toBe('other');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/api.test.ts`
Expected: FAIL, `./api` not found.

- [ ] **Step 4: Implement**

`apps/hub/src/connectors/youtube/api.ts`:
```ts
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fromGrpcResponse, type YtListResponse } from './normalize';

const API = 'https://www.googleapis.com/youtube/v3';
const GRPC_HOST = 'youtube.googleapis.com:443';
const PROTO_PATH = fileURLToPath(new URL('./stream_list.proto', import.meta.url));

export type YouTubeApiErrorKind = 'auth' | 'ended' | 'rate' | 'other';

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly kind: YouTubeApiErrorKind,
  ) {
    super(message);
  }
}

export type StreamHandlers = {
  onResponse(r: YtListResponse): void;
  onError(err: YouTubeApiError): void;
  onEnd(): void;
};

export type ChatStream = { cancel(): void };

export interface YouTubeApi {
  findActiveChat(token: string): Promise<{ liveChatId: string; title: string } | null>;
  myChannelTitle(token: string): Promise<string | undefined>;
  pollChat(token: string, liveChatId: string, pageToken?: string): Promise<YtListResponse>;
  streamChat(token: string, liveChatId: string, pageToken: string | undefined, handlers: StreamHandlers): ChatStream;
}

const RATE_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'userRateLimitExceeded']);
const ENDED_REASONS = new Set(['liveChatEnded', 'liveChatDisabled', 'liveChatNotFound']);

async function restError(res: Response): Promise<YouTubeApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: Array<{ reason?: string }> };
  };
  const reason = body.error?.errors?.[0]?.reason ?? '';
  const message = `YouTube API ${res.status}${reason ? ` (${reason})` : ''}`;
  if (res.status === 401) return new YouTubeApiError(message, 'auth');
  if (RATE_REASONS.has(reason)) return new YouTubeApiError('YouTube quota or rate limit reached', 'rate');
  if (ENDED_REASONS.has(reason) || res.status === 404) return new YouTubeApiError(message, 'ended');
  return new YouTubeApiError(message, 'other');
}

export function mapGrpcError(err: { code?: number; details?: string; message?: string }): YouTubeApiError {
  const message = `YouTube stream: ${err.details || err.message || `gRPC status ${err.code}`}`;
  switch (err.code) {
    case grpc.status.UNAUTHENTICATED:
      return new YouTubeApiError(message, 'auth');
    case grpc.status.FAILED_PRECONDITION:
    case grpc.status.NOT_FOUND:
      return new YouTubeApiError(message, 'ended');
    case grpc.status.RESOURCE_EXHAUSTED:
      return new YouTubeApiError('YouTube quota or rate limit reached', 'rate');
    default:
      return new YouTubeApiError(message, 'other');
  }
}

let serviceCtor: grpc.ServiceClientConstructor | null = null;

export function loadStreamListService(): grpc.ServiceClientConstructor {
  if (!serviceCtor) {
    const definition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: false,
      oneofs: false,
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      youtube: { api: { v3: { V3DataLiveChatMessageService: grpc.ServiceClientConstructor } } };
    };
    serviceCtor = pkg.youtube.api.v3.V3DataLiveChatMessageService;
  }
  return serviceCtor;
}

type StreamListClient = grpc.Client & {
  StreamList(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<YtListResponse>;
};

export function createYouTubeApi(fetchFn: typeof fetch = fetch): YouTubeApi {
  const get = async (path: string, params: Record<string, string>, token: string) => {
    const url = new URL(`${API}${path}`);
    url.search = new URLSearchParams(params).toString();
    const res = await fetchFn(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await restError(res);
    return res.json() as Promise<Record<string, unknown>>;
  };

  return {
    async findActiveChat(token) {
      const body = (await get('/liveBroadcasts', { part: 'snippet', broadcastStatus: 'active', broadcastType: 'all' }, token)) as {
        items?: Array<{ snippet?: { title?: string; liveChatId?: string } }>;
      };
      const live = body.items?.find((b) => b.snippet?.liveChatId);
      return live ? { liveChatId: live.snippet!.liveChatId!, title: live.snippet!.title ?? 'YouTube live' } : null;
    },

    async myChannelTitle(token) {
      const body = (await get('/channels', { part: 'snippet', mine: 'true' }, token)) as {
        items?: Array<{ snippet?: { title?: string } }>;
      };
      return body.items?.[0]?.snippet?.title;
    },

    async pollChat(token, liveChatId, pageToken) {
      const params: Record<string, string> = { liveChatId, part: 'snippet,authorDetails' };
      if (pageToken) params.pageToken = pageToken;
      return (await get('/liveChat/messages', params, token)) as YtListResponse;
    },

    streamChat(token, liveChatId, pageToken, handlers) {
      const Service = loadStreamListService();
      const client = new Service(GRPC_HOST, grpc.credentials.createSsl()) as StreamListClient;
      const metadata = new grpc.Metadata();
      metadata.set('authorization', `Bearer ${token}`);
      const request: Record<string, unknown> = { liveChatId, part: ['snippet', 'authorDetails'], profileImageSize: 88 };
      if (pageToken) request.pageToken = pageToken;
      let cancelled = false;
      const call = client.StreamList(request, metadata);
      call.on('data', (r: YtListResponse) => handlers.onResponse(fromGrpcResponse(r)));
      call.on('error', (err: grpc.ServiceError) => {
        if (!cancelled) handlers.onError(mapGrpcError(err));
      });
      call.on('end', () => {
        if (!cancelled) handlers.onEnd();
      });
      return {
        cancel() {
          cancelled = true;
          call.cancel();
          client.close();
        },
      };
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/api.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS (10 tests). proto-loader bundles the protobuf well-known types, so `google/protobuf/duration.proto` should resolve with no extra options. If the `loads the published streamList service definition` test fails with an import error, run `find node_modules -path '*google/protobuf/duration.proto'`. Then add `includeDirs: [<the directory that contains google/>]` to the `loadSync` options and record a ruling.

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "feat(hub): YouTube API client with REST lookups/polling and gRPC streamList"
```

---

### Task 9: YouTube connector

**Files:**
- Create: `apps/hub/src/connectors/youtube/connector.ts`, `apps/hub/src/connectors/youtube/connector.test.ts`

**Interfaces:**
- Consumes:
  - `Connector` (Task 5)
  - `TokenSource`, `YouTubeAuthError` (Task 6)
  - `normalizeYouTubeItem`, `YtListResponse` (Task 7)
  - `YouTubeApi`, `YouTubeApiError`, `ChatStream` (Task 8)
  - `backoffDelay`, `Timer`, `realTimer`, `describeError`, `FakeTimer`, `settle`
- Produces:
  - `class YouTubeConnector implements Connector`:
    - `constructor(opts: { bus: Bus; tokens: TokenSource & { connected(): boolean }; api: YouTubeApi; channel: () => string; timer?: Timer; rand?: () => number; now?: () => number; offlineCheckMs?: number; streamFailuresBeforePolling?: number })`
  - Defaults: `offlineCheckMs = 60_000`, `streamFailuresBeforePolling = 3`, `BACKLOG_MS = 5000`.
  - Source: `'connector:youtube'`.

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/connectors/youtube/connector.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../../bus/bus';
import { FakeTimer, settle } from '../../testing/timer';
import { YouTubeApiError, type StreamHandlers, type YouTubeApi } from './api';
import { YouTubeAuthError } from './auth';
import { YouTubeConnector } from './connector';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const msg = (id: string, at = '2026-10-01T12:00:01Z', type = 'textMessageEvent') => ({
  id,
  snippet: { type, publishedAt: at, displayMessage: `msg ${id}` },
  authorDetails: { channelId: 'UC1', displayName: 'Viewer' },
});

let bus: Bus;
let timer: FakeTimer;
let events: Envelope[];
let streams: Array<{ pageToken?: string; handlers: StreamHandlers; cancelled: boolean }>;
let api: { [K in keyof YouTubeApi]: ReturnType<typeof vi.fn> };
let tokens: { accessToken: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn>; connected: () => boolean };
let connector: YouTubeConnector;

beforeEach(() => {
  bus = new Bus();
  timer = new FakeTimer();
  events = [];
  streams = [];
  bus.subscribe(['chat.', 'platform.status'], (e) => events.push(e));
  api = {
    findActiveChat: vi.fn(async () => ({ liveChatId: 'CHAT', title: 'Show #1' })),
    myChannelTitle: vi.fn(),
    pollChat: vi.fn(async () => ({ nextPageToken: 'p2', pollingIntervalMillis: 4000, items: [msg('polled')] })),
    streamChat: vi.fn((_t: string, _c: string, pageToken: string | undefined, handlers: StreamHandlers) => {
      const s = { pageToken, handlers, cancelled: false };
      streams.push(s);
      return { cancel: () => void (s.cancelled = true) };
    }),
  };
  tokens = { accessToken: vi.fn(async () => 'tok'), invalidate: vi.fn(), connected: () => true };
  connector = new YouTubeConnector({
    bus,
    tokens,
    api: api as unknown as YouTubeApi,
    channel: () => 'My Channel',
    timer,
    rand: () => 1,
    now: () => T0,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const statuses = () => events.filter((e) => e.type === 'platform.status').map((e) => e.payload);
const lastStatus = () => statuses().at(-1);
const ofType = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);

describe('YouTubeConnector', () => {
  it('reports disconnected when YouTube is not connected', () => {
    tokens.connected = () => false;
    connector.start();
    expect(api.findActiveChat).not.toHaveBeenCalled();
    expect(lastStatus()).toMatchObject({ platform: 'youtube', status: 'disconnected' });
  });

  it('reports offline and re-checks every minute when nothing is live', async () => {
    api.findActiveChat.mockResolvedValueOnce(null);
    connector.start();
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'offline' });
    expect(timer.has(60_000)).toBe(true);
    timer.fire(60_000);
    await settle();
    expect(api.findActiveChat).toHaveBeenCalledTimes(2);
    expect(api.streamChat).toHaveBeenCalledTimes(1);
  });

  it('streams chat, goes live, and drops duplicates and backlog', async () => {
    connector.start();
    await settle();
    expect(api.streamChat.mock.calls[0]!.slice(0, 3)).toEqual(['tok', 'CHAT', undefined]);
    streams[0]!.handlers.onResponse({
      nextPageToken: 'n1',
      items: [msg('old', '2026-10-01T11:00:00Z'), msg('a'), msg('a')],
    });
    expect(lastStatus()).toMatchObject({ status: 'live' });
    expect(ofType('chat.message')).toEqual([expect.objectContaining({ id: 'youtube:a', channel: 'My Channel' })]);
  });

  it('resumes from the last page token after a stream error', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onResponse({ nextPageToken: 'n1', items: [] });
    streams[0]!.handlers.onError(new YouTubeApiError('unavailable', 'other'));
    timer.fire(1000);
    await settle();
    expect(streams[1]!.pageToken).toBe('n1');
  });

  it('falls back to polling after repeated stream failures', async () => {
    connector.start();
    await settle();
    for (let i = 0; i < 3; i++) {
      streams.at(-1)!.handlers.onError(new YouTubeApiError('unavailable', 'other'));
      timer.fire(timer.queue[0]!.ms);
      await settle();
    }
    expect(api.pollChat).toHaveBeenCalledTimes(1);
    expect(ofType('chat.message')).toEqual([expect.objectContaining({ id: 'youtube:polled' })]);
    expect(timer.has(4000)).toBe(true);
    timer.fire(4000);
    await settle();
    expect(api.pollChat.mock.calls[1]![2]).toBe('p2');
  });

  it('goes offline when the chat ends and looks for the next broadcast', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onResponse({ items: [msg('end', '2026-10-01T12:00:02Z', 'chatEndedEvent')] });
    expect(streams[0]!.cancelled).toBe(true);
    expect(lastStatus()).toMatchObject({ status: 'offline' });
    expect(timer.has(60_000)).toBe(true);
  });

  it('treats an ended-chat error and offlineAt as the end of the broadcast', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onError(new YouTubeApiError('liveChatEnded', 'ended'));
    expect(lastStatus()).toMatchObject({ status: 'offline' });
    timer.fire(60_000);
    await settle();
    streams[1]!.handlers.onResponse({ offlineAt: '2026-10-01T13:00:00Z', items: [] });
    expect(streams[1]!.cancelled).toBe(true);
    expect(lastStatus()).toMatchObject({ status: 'offline' });
  });

  it('invalidates the token on an auth error and retries', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onError(new YouTubeApiError('401', 'auth'));
    expect(tokens.invalidate).toHaveBeenCalled();
    timer.fire(1000);
    await settle();
    expect(streams).toHaveLength(2);
  });

  it('stops with a reconnect message when the sign-in is gone', async () => {
    tokens.accessToken.mockRejectedValue(new YouTubeAuthError('YouTube sign-in expired. Reconnect YouTube on the Connections page.'));
    connector.start();
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('Reconnect YouTube') });
    expect(timer.queue).toEqual([]);
  });

  it('publishes best-effort deletions and ban clears', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onResponse({
      items: [
        { id: 'gone', snippet: { type: 'tombstone' } },
        { id: 'ban', snippet: { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { channelId: 'UCbad' } } } },
      ],
    });
    expect(ofType('chat.deleted')).toEqual([{ id: 'youtube:gone' }]);
    expect(ofType('chat.cleared')).toEqual([{ platform: 'youtube', authorId: 'UCbad' }]);
  });

  it('stop cancels the stream and ignores late responses', async () => {
    connector.start();
    await settle();
    await connector.stop();
    expect(streams[0]!.cancelled).toBe(true);
    streams[0]!.handlers.onResponse({ items: [msg('late')] });
    expect(ofType('chat.message')).toEqual([]);
    expect(lastStatus()).toMatchObject({ status: 'disconnected' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube/connector.test.ts`
Expected: FAIL, `./connector` not found.

- [ ] **Step 3: Implement**

`apps/hub/src/connectors/youtube/connector.ts`:
```ts
import type { ConnectorStatus, EventPayload, KnownEventType } from '@streamhub/shared';
import type { Bus } from '../../bus/bus';
import { backoffDelay } from '../../util/backoff';
import { describeError } from '../../util/errors';
import { realTimer, type Timer } from '../../util/timer';
import type { Connector } from '../types';
import { YouTubeApiError, type ChatStream, type YouTubeApi } from './api';
import { YouTubeAuthError, type TokenSource } from './auth';
import { normalizeYouTubeItem, type YtListResponse } from './normalize';

const BACKLOG_MS = 5000;
const SEEN_LIMIT = 2000;
const MIN_POLL_MS = 1000;

export type YouTubeConnectorOptions = {
  bus: Bus;
  tokens: TokenSource & { connected(): boolean };
  api: YouTubeApi;
  channel: () => string;
  timer?: Timer;
  rand?: () => number;
  now?: () => number;
  offlineCheckMs?: number;
  streamFailuresBeforePolling?: number;
};

type ActiveChat = {
  liveChatId: string;
  title: string;
  pageToken?: string;
  connectedAt: number;
  mode: 'stream' | 'poll';
  failures: number;
};

/** Finds the live broadcast, streams its chat (polling as fallback). See docs/connectors/youtube.md. */
export class YouTubeConnector implements Connector {
  readonly platform = 'youtube' as const;
  private stopped = true;
  private generation = 0;
  private pending: unknown = null;
  private stream: ChatStream | null = null;
  private chat: ActiveChat | null = null;
  private attempt = 0;
  private current: ConnectorStatus | null = null;
  private readonly seen = new Set<string>();
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly offlineCheckMs: number;
  private readonly maxStreamFailures: number;

  constructor(private readonly opts: YouTubeConnectorOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.offlineCheckMs = opts.offlineCheckMs ?? 60_000;
    this.maxStreamFailures = opts.streamFailuresBeforePolling ?? 3;
  }

  start() {
    this.stopped = false;
    this.generation++;
    if (!this.opts.tokens.connected()) {
      this.status('disconnected', 'Connect YouTube on the Connections page');
      return;
    }
    void this.findChat();
  }

  async stop() {
    this.shutdown();
    this.status('disconnected');
  }

  private shutdown() {
    this.stopped = true;
    this.generation++;
    if (this.pending !== null) this.timer.clear(this.pending);
    this.pending = null;
    this.stream?.cancel();
    this.stream = null;
    this.chat = null;
  }

  private later(fn: () => void, ms: number) {
    if (this.pending !== null) this.timer.clear(this.pending);
    const gen = this.generation;
    this.pending = this.timer.set(() => {
      this.pending = null;
      if (!this.stopped && gen === this.generation) fn();
    }, ms);
  }

  private async findChat() {
    const gen = this.generation;
    try {
      const token = await this.opts.tokens.accessToken();
      const found = await this.opts.api.findActiveChat(token);
      if (gen !== this.generation) return;
      this.attempt = 0;
      if (!found) {
        this.status('offline', 'No live broadcast right now');
        this.later(() => void this.findChat(), this.offlineCheckMs);
        return;
      }
      this.chat = { ...found, connectedAt: this.now(), mode: 'stream', failures: 0 };
      this.status('connecting', found.title);
      void this.connectChat();
    } catch (err) {
      if (gen === this.generation) this.onError(err, () => void this.findChat());
    }
  }

  private async connectChat() {
    const chat = this.chat;
    if (!chat) return;
    let token: string;
    try {
      token = await this.opts.tokens.accessToken();
    } catch (err) {
      if (this.chat === chat) this.onError(err, () => void this.connectChat());
      return;
    }
    if (this.chat !== chat) return;
    if (chat.mode === 'poll') {
      void this.poll(chat, token);
      return;
    }
    this.stream = this.opts.api.streamChat(token, chat.liveChatId, chat.pageToken, {
      onResponse: (r) => {
        if (this.chat !== chat) return;
        chat.failures = 0;
        this.attempt = 0;
        this.handleResponse(chat, r);
      },
      onError: (err) => {
        if (this.chat !== chat) return;
        this.stream = null;
        if (err.kind === 'other' || err.kind === 'rate') {
          chat.failures++;
          if (chat.failures >= this.maxStreamFailures) {
            chat.mode = 'poll';
            console.warn('[youtube] streamList keeps failing; switching to polling');
          }
        }
        this.onError(err, () => void this.connectChat());
      },
      onEnd: () => {
        if (this.chat !== chat) return;
        this.stream = null;
        this.later(() => void this.connectChat(), backoffDelay(this.attempt++, this.rand));
      },
    });
  }

  private async poll(chat: ActiveChat, token: string) {
    try {
      const r = await this.opts.api.pollChat(token, chat.liveChatId, chat.pageToken);
      if (this.chat !== chat) return;
      this.attempt = 0;
      this.handleResponse(chat, r);
      if (this.chat === chat) {
        this.later(() => void this.connectChat(), Math.max(MIN_POLL_MS, r.pollingIntervalMillis ?? 5000));
      }
    } catch (err) {
      if (this.chat === chat) this.onError(err, () => void this.connectChat());
    }
  }

  private handleResponse(chat: ActiveChat, r: YtListResponse) {
    if (r.nextPageToken) chat.pageToken = r.nextPageToken;
    if (this.current !== 'live') this.status('live', chat.title);
    const channel = this.opts.channel();
    for (const item of r.items ?? []) {
      const n = normalizeYouTubeItem(item, channel, this.now);
      if (!n) continue;
      if (n.kind === 'ended') {
        this.endChat();
        return;
      }
      if (n.kind === 'deleted') this.publish('chat.deleted', { id: n.id });
      if (n.kind === 'cleared') this.publish('chat.cleared', { platform: 'youtube', authorId: n.authorId });
      if (n.kind === 'message') {
        if (this.seen.has(n.message.id)) continue;
        this.seen.add(n.message.id);
        if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
        if (n.message.sentAt < chat.connectedAt - BACKLOG_MS) continue;
        this.publish('chat.message', n.message);
      }
    }
    if (r.offlineAt) this.endChat();
  }

  private endChat() {
    this.stream?.cancel();
    this.stream = null;
    this.chat = null;
    this.status('offline', 'Broadcast ended');
    this.later(() => void this.findChat(), this.offlineCheckMs);
  }

  private onError(err: unknown, retry: () => void) {
    if (err instanceof YouTubeAuthError) {
      this.shutdown();
      this.status('error', err.message);
      return;
    }
    if (err instanceof YouTubeApiError) {
      if (err.kind === 'ended') {
        this.endChat();
        return;
      }
      if (err.kind === 'auth') this.opts.tokens.invalidate();
      this.status(err.kind === 'rate' ? 'error' : 'connecting', err.message);
    } else {
      this.status('error', describeError(err));
    }
    this.later(retry, backoffDelay(this.attempt++, this.rand));
  }

  private status(status: ConnectorStatus, detail?: string) {
    this.current = status;
    this.publish('platform.status', { platform: 'youtube', status, ...(detail ? { detail } : {}) });
  }

  private publish<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    const result = this.opts.bus.publish({ type, payload, source: 'connector:youtube' });
    if (!result.ok) console.warn(`[youtube] dropped invalid ${type}: ${result.error}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/youtube && pnpm typecheck && pnpm lint`
Expected: PASS (11 connector tests plus the earlier YouTube tests).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): YouTube connector with offline detection, stream resume and polling fallback"
```

---

### Task 10: Connections service, connector manager, OAuth callback route, hub wiring

**Files:**
- Create: `apps/hub/src/connectors/manager.ts`, `apps/hub/src/connectors/manager.test.ts`
- Create: `apps/hub/src/connections/service.ts`, `apps/hub/src/connections/service.test.ts`
- Modify: `apps/hub/src/server.ts` (+ `server.test.ts`), `apps/hub/src/main.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `class ConnectorManager { constructor(connectors: Connector[]); startAll(): void; restart(platform: Platform): void; halt(platform: Platform): Promise<void>; stopAll(): Promise<void> }`
  - `class ConnectionsService`:
    - `constructor(deps: ConnectionsDeps)`
    - `start(): void`
    - `handleYouTubeCallback(query: Record<string, string | undefined>): Promise<string>`
  - `type ConnectionsDeps`:
    - `bus: Bus`
    - `twitch: Pick<TwitchAuth, 'tokens' | 'startDeviceFlow' | 'pollDeviceFlow' | 'clear'> | null`
    - `youtube: Pick<YouTubeAuth, 'clientConfigured' | 'connected' | 'account' | 'setClient' | 'setAccount' | 'beginAuth' | 'completeAuth' | 'accessToken' | 'clearTokens'>`
    - `youtubeApi: Pick<YouTubeApi, 'myChannelTitle'>`
    - `restart(platform: Platform): void`
    - `halt(platform: Platform): Promise<void>`
  - `ServerOptions` gains `youtubeCallback?: (query: Record<string, string | undefined>) => Promise<string>`, served at `GET /oauth/youtube/callback` as `text/plain`.

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/connectors/manager.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { ConnectorManager } from './manager';
import type { Connector } from './types';

const fake = (platform: 'twitch' | 'youtube'): Connector & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => ({
  platform,
  start: vi.fn(),
  stop: vi.fn(async () => {}),
});

describe('ConnectorManager', () => {
  it('starts all connectors and keeps going if one throws', () => {
    const a = fake('twitch');
    const b = fake('youtube');
    a.start.mockImplementation(() => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    new ConnectorManager([a, b]).startAll();
    expect(b.start).toHaveBeenCalled();
  });

  it('restarts one platform (stop, then start)', async () => {
    const a = fake('twitch');
    const m = new ConnectorManager([a, fake('youtube')]);
    m.restart('twitch');
    await vi.waitFor(() => expect(a.start).toHaveBeenCalled());
    expect(a.stop.mock.invocationCallOrder[0]).toBeLessThan(a.start.mock.invocationCallOrder[0]!);
  });

  it('ignores platforms without a connector', async () => {
    const m = new ConnectorManager([fake('youtube')]);
    m.restart('twitch');
    await expect(m.halt('kick')).resolves.toBeUndefined();
  });
});
```

`apps/hub/src/connections/service.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { settle } from '../testing/timer';
import { ConnectionsService, type ConnectionsDeps } from './service';

let bus: Bus;
let all: Envelope[];
let twitch: { [K in 'tokens' | 'startDeviceFlow' | 'pollDeviceFlow' | 'clear']: ReturnType<typeof vi.fn> };
let youtube: Record<string, ReturnType<typeof vi.fn>>;
let restart: ReturnType<typeof vi.fn>;
let halt: ReturnType<typeof vi.fn>;
let service: ConnectionsService;

const make = (overrides: Partial<ConnectionsDeps> = {}) =>
  new ConnectionsService({
    bus,
    twitch: twitch as never,
    youtube: youtube as never,
    youtubeApi: { myChannelTitle: vi.fn(async () => 'Your Average Tech Founder') },
    restart,
    halt,
    ...overrides,
  });

beforeEach(() => {
  bus = new Bus();
  all = [];
  bus.subscribe(['*'], (e) => all.push(e));
  twitch = {
    tokens: vi.fn(() => undefined),
    startDeviceFlow: vi.fn(async () => ({ deviceCode: 'd', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH', intervalMs: 5000, expiresAt: 1e15 })),
    pollDeviceFlow: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', userId: '1', login: 'yatf' })),
    clear: vi.fn(async () => {}),
  };
  let configured = false;
  youtube = {
    clientConfigured: vi.fn(() => configured),
    connected: vi.fn(() => false),
    account: vi.fn(() => undefined),
    setClient: vi.fn(async () => void (configured = true)),
    setAccount: vi.fn(async () => {}),
    beginAuth: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?x=1'),
    completeAuth: vi.fn(async () => {}),
    accessToken: vi.fn(async () => 'tok'),
    clearTokens: vi.fn(async () => {}),
  };
  restart = vi.fn();
  halt = vi.fn(async () => {});
  service = make();
});

const states = (platform: string) =>
  all.filter((e) => e.type === 'connections.state' && (e.payload as { platform: string }).platform === platform).map((e) => e.payload);
const cmd = (type: string, payload: unknown) => bus.publish({ type, payload, source: 'dashboard' });

describe('ConnectionsService', () => {
  it('publishes initial states', () => {
    twitch.tokens.mockReturnValue({ login: 'yatf' });
    service.start();
    expect(states('twitch')).toEqual([{ platform: 'twitch', state: 'connected', account: 'yatf' }]);
    expect(states('youtube')).toEqual([{ platform: 'youtube', state: 'disconnected', clientConfigured: false }]);
    expect(states('kick')).toEqual([{ platform: 'kick', state: 'disconnected', detail: 'Kick arrives with the relay (M3).' }]);
  });

  it('explains how to configure Twitch when no client id is set', () => {
    make({ twitch: null }).start();
    expect(states('twitch')[0]).toMatchObject({ state: 'disconnected', detail: expect.stringContaining('TWITCH_CLIENT_ID') });
  });

  it('runs the Twitch device flow and restarts the connector', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    expect(states('twitch').slice(1)).toEqual([
      { platform: 'twitch', state: 'pending', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' },
      { platform: 'twitch', state: 'connected', account: 'yatf' },
    ]);
    expect(restart).toHaveBeenCalledWith('twitch');
  });

  it('reports a failed Twitch sign-in', async () => {
    twitch.pollDeviceFlow.mockRejectedValue(new Error('The code expired before it was approved. Try again.'));
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    expect(states('twitch').at(-1)).toEqual({ platform: 'twitch', state: 'error', detail: 'The code expired before it was approved. Try again.' });
  });

  it('disconnects Twitch: stops the connector and forgets tokens', async () => {
    service.start();
    cmd('connections.cmd.disconnect', { platform: 'twitch' });
    await settle();
    expect(halt).toHaveBeenCalledWith('twitch');
    expect(twitch.clear).toHaveBeenCalled();
    expect(states('twitch').at(-1)).toMatchObject({ state: 'disconnected' });
  });

  it('saves the YouTube client and never publishes the client secret', async () => {
    service.start();
    cmd('connections.cmd.setYoutubeClient', { clientId: 'cid', clientSecret: 'TOPSECRET' });
    await settle();
    expect(youtube.setClient).toHaveBeenCalledWith('cid', 'TOPSECRET');
    expect(states('youtube').at(-1)).toEqual({ platform: 'youtube', state: 'disconnected', clientConfigured: true });
    const leaked = all.filter((e) => e.type !== 'connections.cmd.setYoutubeClient' && JSON.stringify(e).includes('TOPSECRET'));
    expect(leaked).toEqual([]);
  });

  it('asks for a client before YouTube sign-in', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'youtube' });
    await settle();
    expect(states('youtube').at(-1)).toMatchObject({ state: 'error', detail: expect.stringContaining('docs/setup/youtube.md') });
  });

  it('runs the YouTube sign-in through the callback', async () => {
    youtube.clientConfigured.mockReturnValue(true);
    service.start();
    cmd('connections.cmd.connect', { platform: 'youtube' });
    await settle();
    expect(states('youtube').at(-1)).toEqual({
      platform: 'youtube',
      state: 'pending',
      clientConfigured: true,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    });
    const page = await service.handleYouTubeCallback({ code: 'c', state: 's' });
    expect(youtube.completeAuth).toHaveBeenCalledWith({ code: 'c', state: 's', error: undefined });
    expect(youtube.setAccount).toHaveBeenCalledWith('Your Average Tech Founder');
    expect(page).toContain('YouTube is connected');
    expect(states('youtube').at(-1)).toEqual({ platform: 'youtube', state: 'connected', clientConfigured: true, account: 'Your Average Tech Founder' });
    expect(restart).toHaveBeenCalledWith('youtube');
  });

  it('reports a rejected YouTube callback', async () => {
    youtube.clientConfigured.mockReturnValue(true);
    youtube.completeAuth.mockRejectedValue(new Error('This sign-in link is invalid or expired.'));
    service.start();
    const page = await service.handleYouTubeCallback({ state: 'forged', code: 'c' });
    expect(page).toContain('invalid or expired');
    expect(states('youtube').at(-1)).toMatchObject({ state: 'error' });
    expect(restart).not.toHaveBeenCalled();
  });

  it('answers Kick with the M3 note', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'kick' });
    await settle();
    expect(states('kick').at(-1)).toMatchObject({ state: 'error', detail: 'Kick arrives with the relay (M3).' });
  });
});
```

Append to `apps/hub/src/server.test.ts`:
```ts
describe('YouTube OAuth callback', () => {
  it('passes the query to the callback handler and returns its text', async () => {
    const seen: unknown[] = [];
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: false,
      youtubeCallback: async (q) => {
        seen.push(q);
        return 'YouTube is connected. You can close this tab.';
      },
    });
    const res = await app.inject({ method: 'GET', url: '/oauth/youtube/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('YouTube is connected. You can close this tab.');
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
    await app.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/hub exec vitest run src/connectors/manager.test.ts src/connections src/server.test.ts`
Expected: FAIL. `./manager` and `./service` are not found, and the callback route returns 404.

- [ ] **Step 3: Implement**

`apps/hub/src/connectors/manager.ts`:
```ts
import type { Platform } from '@streamhub/shared';
import type { Connector } from './types';

export class ConnectorManager {
  private readonly byPlatform = new Map<Platform, Connector>();

  constructor(connectors: Connector[]) {
    for (const c of connectors) this.byPlatform.set(c.platform, c);
  }

  startAll() {
    for (const c of this.byPlatform.values()) this.safeStart(c);
  }

  restart(platform: Platform) {
    const c = this.byPlatform.get(platform);
    if (!c) return;
    void c.stop().then(() => this.safeStart(c));
  }

  async halt(platform: Platform) {
    await this.byPlatform.get(platform)?.stop();
  }

  async stopAll() {
    await Promise.all([...this.byPlatform.values()].map((c) => c.stop()));
  }

  private safeStart(c: Connector) {
    try {
      c.start();
    } catch (err) {
      console.error(`[connectors] ${c.platform} failed to start`, err);
    }
  }
}
```

`apps/hub/src/connections/service.ts`:
```ts
import type { ConnectionState, Envelope, EventPayload, Platform } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { TwitchAuth } from '../connectors/twitch/auth';
import type { YouTubeApi } from '../connectors/youtube/api';
import type { YouTubeAuth } from '../connectors/youtube/auth';
import { describeError } from '../util/errors';

const KICK_NOTE = 'Kick arrives with the relay (M3).';
const TWITCH_SETUP = 'Set TWITCH_CLIENT_ID in .env (see docs/setup/twitch.md), then restart streamhub.';
const YOUTUBE_SETUP = 'Add your Google OAuth client first (see docs/setup/youtube.md).';

export type ConnectionsDeps = {
  bus: Bus;
  twitch: Pick<TwitchAuth, 'tokens' | 'startDeviceFlow' | 'pollDeviceFlow' | 'clear'> | null;
  youtube: Pick<
    YouTubeAuth,
    'clientConfigured' | 'connected' | 'account' | 'setClient' | 'setAccount' | 'beginAuth' | 'completeAuth' | 'accessToken' | 'clearTokens'
  >;
  youtubeApi: Pick<YouTubeApi, 'myChannelTitle'>;
  restart(platform: Platform): void;
  halt(platform: Platform): Promise<void>;
};

/** Turns connections.cmd.* into auth flows; publishes retained connections.state. Never publishes secrets. */
export class ConnectionsService {
  private twitchAbort: AbortController | null = null;

  constructor(private readonly deps: ConnectionsDeps) {}

  start() {
    const { twitch, youtube } = this.deps;
    const t = twitch?.tokens();
    this.state(
      t ? { platform: 'twitch', state: 'connected', account: t.login } : { platform: 'twitch', state: 'disconnected', ...(twitch ? {} : { detail: TWITCH_SETUP }) },
    );
    this.state(this.youtubeIdle());
    this.state({ platform: 'kick', state: 'disconnected', detail: KICK_NOTE });
    this.deps.bus.subscribe(['connections.cmd.'], (e) => void this.handle(e));
  }

  async handleYouTubeCallback(query: Record<string, string | undefined>): Promise<string> {
    const { youtube } = this.deps;
    try {
      await youtube.completeAuth({ code: query.code, state: query.state, error: query.error });
      const title = await this.deps.youtubeApi.myChannelTitle(await youtube.accessToken()).catch(() => undefined);
      await youtube.setAccount(title);
      this.state({ platform: 'youtube', state: 'connected', clientConfigured: true, ...(title ? { account: title } : {}) });
      this.deps.restart('youtube');
      return 'YouTube is connected. You can close this tab and go back to streamhub.';
    } catch (err) {
      const detail = describeError(err);
      this.state({ platform: 'youtube', state: 'error', clientConfigured: youtube.clientConfigured(), detail });
      return `YouTube connection failed: ${detail}`;
    }
  }

  private async handle(e: Envelope) {
    try {
      switch (e.type) {
        case 'connections.cmd.connect':
          return await this.connect((e.payload as EventPayload<'connections.cmd.connect'>).platform);
        case 'connections.cmd.disconnect':
          return await this.disconnect((e.payload as EventPayload<'connections.cmd.disconnect'>).platform);
        case 'connections.cmd.setYoutubeClient': {
          const p = e.payload as EventPayload<'connections.cmd.setYoutubeClient'>;
          await this.deps.halt('youtube');
          await this.deps.youtube.setClient(p.clientId, p.clientSecret);
          this.state(this.youtubeIdle());
          return;
        }
      }
    } catch (err) {
      console.warn(`[connections] ${e.type} failed: ${describeError(err)}`);
    }
  }

  private async connect(platform: Platform) {
    if (platform === 'kick') return this.state({ platform: 'kick', state: 'error', detail: KICK_NOTE });
    if (platform === 'youtube') return this.connectYouTube();
    return this.connectTwitch();
  }

  private async connectTwitch() {
    const { twitch } = this.deps;
    if (!twitch) return this.state({ platform: 'twitch', state: 'error', detail: TWITCH_SETUP });
    this.twitchAbort?.abort();
    const abort = new AbortController();
    this.twitchAbort = abort;
    try {
      const code = await twitch.startDeviceFlow();
      this.state({ platform: 'twitch', state: 'pending', userCode: code.userCode, verificationUri: code.verificationUri });
      const tokens = await twitch.pollDeviceFlow(code, abort.signal);
      this.state({ platform: 'twitch', state: 'connected', account: tokens.login });
      this.deps.restart('twitch');
    } catch (err) {
      if (!abort.signal.aborted) this.state({ platform: 'twitch', state: 'error', detail: describeError(err) });
    }
  }

  private connectYouTube() {
    const { youtube } = this.deps;
    if (!youtube.clientConfigured()) {
      return this.state({ platform: 'youtube', state: 'error', clientConfigured: false, detail: YOUTUBE_SETUP });
    }
    this.state({ platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: youtube.beginAuth() });
  }

  private async disconnect(platform: Platform) {
    if (platform === 'kick') return;
    await this.deps.halt(platform);
    if (platform === 'twitch') {
      this.twitchAbort?.abort();
      await this.deps.twitch?.clear();
      return this.state({ platform: 'twitch', state: 'disconnected', ...(this.deps.twitch ? {} : { detail: TWITCH_SETUP }) });
    }
    await this.deps.youtube.clearTokens();
    this.state(this.youtubeIdle());
  }

  private youtubeIdle(): ConnectionState {
    const { youtube } = this.deps;
    if (youtube.connected()) {
      const account = youtube.account();
      return { platform: 'youtube', state: 'connected', clientConfigured: true, ...(account ? { account } : {}) };
    }
    return { platform: 'youtube', state: 'disconnected', clientConfigured: youtube.clientConfigured() };
  }

  private state(payload: ConnectionState) {
    this.deps.bus.publish({ type: 'connections.state', payload, source: 'hub' });
  }
}
```

In `apps/hub/src/server.ts`:
- add to `ServerOptions`: `youtubeCallback?: (query: Record<string, string | undefined>) => Promise<string>;`
- after the `/health` route add:
```ts
  if (opts.youtubeCallback) {
    const callback = opts.youtubeCallback;
    app.get('/oauth/youtube/callback', async (req, reply) =>
      reply.type('text/plain; charset=utf-8').send(await callback(req.query as Record<string, string | undefined>)),
    );
  }
```

Replace `apps/hub/src/main.ts` with:
```ts
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import OBSWebSocket from 'obs-websocket-js';
import { WebSocket } from 'ws';
import { Bus } from './bus/bus';
import { loadConfig } from './config';
import { ConnectionsService } from './connections/service';
import { ConnectorManager } from './connectors/manager';
import { TwitchAuth } from './connectors/twitch/auth';
import { TwitchConnector } from './connectors/twitch/connector';
import type { Connector, SocketLike } from './connectors/types';
import { createYouTubeApi } from './connectors/youtube/api';
import { YouTubeAuth } from './connectors/youtube/auth';
import { YouTubeConnector } from './connectors/youtube/connector';
import { ObsBridge, type ObsClient } from './obs/bridge';
import { SecretsStore } from './secrets/store';
import { createServer } from './server';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const cfg = loadConfig();

const bus = new Bus();
const store = new SecretsStore(fileURLToPath(new URL('../../../.streamhub/secrets.json', import.meta.url)));
await store.load();

const twitchAuth = cfg.twitchClientId ? new TwitchAuth({ clientId: cfg.twitchClientId, store }) : null;
const youtubeAuth = new YouTubeAuth({ store, redirectUri: `http://127.0.0.1:${cfg.port}/oauth/youtube/callback` });
const youtubeApi = createYouTubeApi();

const connectors: Connector[] = [
  new YouTubeConnector({ bus, tokens: youtubeAuth, api: youtubeApi, channel: () => youtubeAuth.account() ?? 'YouTube' }),
];
if (twitchAuth) {
  connectors.push(
    new TwitchConnector({ bus, auth: twitchAuth, createSocket: (url) => new WebSocket(url) as unknown as SocketLike }),
  );
}
const manager = new ConnectorManager(connectors);
const connections = new ConnectionsService({
  bus,
  twitch: twitchAuth,
  youtube: youtubeAuth,
  youtubeApi,
  restart: (p) => manager.restart(p),
  halt: (p) => manager.halt(p),
});

const app = await createServer({
  bus,
  port: cfg.port,
  dev: cfg.dev,
  dashboardDir: fileURLToPath(new URL('../../dashboard/dist', import.meta.url)),
  youtubeCallback: (q) => connections.handleYouTubeCallback(q),
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
connections.start();
manager.startAll();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 3000).unref();
  await Promise.all([obs.stop(), manager.stopAll()]);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 4: Run tests and a startup smoke check**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

Run the hub in the background (`cd apps/hub && npx tsx src/main.ts`), then:
- `curl -s http://127.0.0.1:4747/health` → `{"ok":true}`
- `curl -s "http://127.0.0.1:4747/oauth/youtube/callback?state=x&code=y"` → `YouTube connection failed: This sign-in link is invalid or expired. …`

Then stop the hub. With no `TWITCH_CLIENT_ID` and no YouTube client, the hub must stay up.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(hub): connections service, connector manager, YouTube OAuth callback and wiring"
```

---

### Task 11: Dashboard unified chat

**Files:**
- Modify: `apps/dashboard/src/state.ts`, `apps/dashboard/src/state.test.ts`
- Modify: `apps/dashboard/src/useDashboardState.ts`
- Create: `apps/dashboard/src/platforms.ts`, `apps/dashboard/src/safeUrl.ts`
- Create: `apps/dashboard/src/components/ChatPanel.tsx`, `apps/dashboard/src/components/ChatPanel.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`, `apps/dashboard/src/styles.css`

**Interfaces:**
- Consumes: `ChatMessage`, `ConnectionState`, `Platform`, `EventPayload`, `Envelope` from shared; `HubClient.history`.
- Produces:
  - `DashboardState` gains `chat: ChatMessage[]` (max `CHAT_LIMIT = 300`), `featuredId: string | null`, `connections: Partial<Record<Platform, ConnectionState>>`
  - `Action` gains `{ kind: 'backfill'; events: Envelope[] }`
  - `PLATFORMS: Record<Platform, { label: string; color: string }>`
  - `safeHttpsUrl(url: string | undefined): string | null`
  - `isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold?: number): boolean`
  - `<ChatPanel messages featuredId onFeature onClearFeature />`

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/src/state.test.ts`:
```ts
import { chatMessage } from '@streamhub/shared/testing';

describe('chat state', () => {
  const chatEv = (id: string, extra: object = {}) => ev('chat.message', chatMessage({ id, ...extra }));

  it('appends messages once and caps the list', () => {
    const events = Array.from({ length: 305 }, (_, i) => chatEv(`twitch:${i}`));
    const s = apply([...events, chatEv('twitch:304')]);
    expect(s.chat).toHaveLength(300);
    expect(s.chat[0]!.id).toBe('twitch:5');
    expect(s.chat.at(-1)!.id).toBe('twitch:304');
  });

  it('removes deleted messages and cleared users or platforms', () => {
    const s = apply([
      chatEv('twitch:1', { author: { id: 'a', name: 'A', roles: [] } }),
      chatEv('twitch:2', { author: { id: 'b', name: 'B', roles: [] } }),
      chatEv('youtube:3', { platform: 'youtube' }),
      chatEv('twitch:4'),
      ev('chat.deleted', { id: 'twitch:4' }),
      ev('chat.cleared', { platform: 'twitch', authorId: 'a' }),
    ]);
    expect(s.chat.map((m) => m.id)).toEqual(['twitch:2', 'youtube:3']);
    expect(apply([ev('chat.cleared', { platform: 'twitch' })], s).chat.map((m) => m.id)).toEqual(['youtube:3']);
  });

  it('backfill merges without duplicates, ordered by time', () => {
    const live = apply([chatEv('twitch:2', { sentAt: 20 })]);
    const s = reduce(live, {
      kind: 'backfill',
      events: [ev('chat.message', chatMessage({ id: 'twitch:1', sentAt: 10 })), ev('chat.message', chatMessage({ id: 'twitch:2', sentAt: 20 }))],
    });
    expect(s.chat.map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
  });

  it('tracks the featured message and connection states', () => {
    const s = apply([
      ev('show.feature.set', { message: chatMessage({ id: 'twitch:9' }) }),
      ev('connections.state', { platform: 'twitch', state: 'connected', account: 'yatf' }),
    ]);
    expect(s.featuredId).toBe('twitch:9');
    expect(s.connections.twitch).toEqual({ platform: 'twitch', state: 'connected', account: 'yatf' });
    expect(apply([ev('show.feature.clear', {})], s).featuredId).toBeNull();
  });
});
```

`apps/dashboard/src/components/ChatPanel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMessage } from '@streamhub/shared/testing';
import { isNearBottom } from './ChatPanel';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

const noop = () => {};

describe('ChatPanel', () => {
  it('renders chat text literally', () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const { container } = render(
      <ChatPanel messages={[chatMessage({ text: evil, fragments: [{ kind: 'text', text: evil }] })]} featuredId={null} onFeature={noop} onClearFeature={noop} />,
    );
    expect(screen.getByText(evil)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows https emotes as images and does not load non-https emote urls', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          chatMessage({
            fragments: [
              { kind: 'emote', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0' },
              { kind: 'emote', name: 'Evil', url: 'javascript:alert(1)' },
            ],
          }),
        ]}
        featuredId={null}
        onFeature={noop}
        onClearFeature={noop}
      />,
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('alt')).toBe('Kappa');
    expect(screen.getByText('Evil')).toBeTruthy();
  });

  it('labels the platform, including YouTube', () => {
    render(<ChatPanel messages={[chatMessage({ id: 'youtube:1', platform: 'youtube' })]} featuredId={null} onFeature={noop} onClearFeature={noop} />);
    expect(screen.getAllByText('YouTube').length).toBeGreaterThan(0);
  });

  it('filters by platform', () => {
    render(
      <ChatPanel
        messages={[chatMessage({ id: 'twitch:1', text: 'from twitch', fragments: [{ kind: 'text', text: 'from twitch' }] }), chatMessage({ id: 'youtube:1', platform: 'youtube', text: 'from yt', fragments: [{ kind: 'text', text: 'from yt' }] })]}
        featuredId={null}
        onFeature={noop}
        onClearFeature={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Twitch' }));
    expect(screen.queryByText('from twitch')).toBeNull();
    expect(screen.getByText('from yt')).toBeTruthy();
  });

  it('features and un-features a message', () => {
    const onFeature = vi.fn();
    const onClear = vi.fn();
    const m = chatMessage();
    const { rerender } = render(<ChatPanel messages={[m]} featuredId={null} onFeature={onFeature} onClearFeature={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Feature' }));
    expect(onFeature).toHaveBeenCalledWith(m);
    rerender(<ChatPanel messages={[m]} featuredId={m.id} onFeature={onFeature} onClearFeature={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unfeature' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('isNearBottom', () => {
  it('is true within the threshold', () => {
    expect(isNearBottom({ scrollTop: 560, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/dashboard exec vitest run`
Expected: FAIL. `chat` is undefined in state and `./ChatPanel` is not found.

- [ ] **Step 3: Implement**

`apps/dashboard/src/platforms.ts`:
```ts
import type { Platform } from '@streamhub/shared';

export const PLATFORMS: Record<Platform, { label: string; color: string }> = {
  twitch: { label: 'Twitch', color: '#9146ff' },
  youtube: { label: 'YouTube', color: '#ff0033' },
  kick: { label: 'Kick', color: '#53fc18' },
};
```

`apps/dashboard/src/safeUrl.ts`:
```ts
/** Only https URLs from chat data may reach an img src or href. */
export function safeHttpsUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
```

In `apps/dashboard/src/state.ts`:
- extend the imports to include `ChatMessage` and `ConnectionState` from `@streamhub/shared`
- extend the types and the reducer:
```ts
export const CHAT_LIMIT = 300;
```
Add these fields to `DashboardState`:
```ts
  chat: ChatMessage[];
  featuredId: string | null;
  connections: Partial<Record<Platform, ConnectionState>>;
```
Replace the `Action` type with:
```ts
export type Action =
  | { kind: 'hub'; connected: boolean }
  | { kind: 'event'; event: Envelope }
  | { kind: 'backfill'; events: Envelope[] };
```
Add to `initialState`: `chat: [], featuredId: null, connections: {},`.
At the start of `reduce`, after the `hub` branch, add:
```ts
  if (action.kind === 'backfill') {
    const known = new Set(state.chat.map((m) => m.id));
    const older = action.events
      .filter((e) => e.type === 'chat.message')
      .map((e) => e.payload as ChatMessage)
      .filter((m) => !known.has(m.id));
    const chat = [...older, ...state.chat].sort((a, b) => a.sentAt - b.sentAt).slice(-CHAT_LIMIT);
    return { ...state, chat };
  }
```
and add these cases to the `switch`:
```ts
    case 'chat.message': {
      const m = payload as ChatMessage;
      if (state.chat.some((c) => c.id === m.id)) return state;
      return { ...state, chat: [...state.chat, m].slice(-CHAT_LIMIT) };
    }
    case 'chat.deleted': {
      const { id } = payload as EventPayload<'chat.deleted'>;
      return { ...state, chat: state.chat.filter((m) => m.id !== id) };
    }
    case 'chat.cleared': {
      const p = payload as EventPayload<'chat.cleared'>;
      return {
        ...state,
        chat: state.chat.filter((m) => m.platform !== p.platform || (p.authorId !== undefined && m.author.id !== p.authorId)),
      };
    }
    case 'show.feature.set':
      return { ...state, featuredId: (payload as EventPayload<'show.feature.set'>).message.id };
    case 'show.feature.clear':
      return { ...state, featuredId: null };
    case 'connections.state': {
      const p = payload as ConnectionState;
      return { ...state, connections: { ...state.connections, [p.platform]: p } };
    }
```
(The existing `'ignores unrelated events'` test uses `show.feature.clear`. Change that test to use `ev('module.demo.ping', {})`, so it still checks that the state object is untouched.)

Replace `apps/dashboard/src/useDashboardState.ts` with:
```ts
import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { CHAT_LIMIT, initialState, reduce, type DashboardState } from './state';

export function useDashboardState(client: HubClient): DashboardState {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    const onEvent = (event: Envelope) => dispatch({ kind: 'event', event });
    const offs = [
      client.onStatus((s) => {
        dispatch({ kind: 'hub', connected: s === 'open' });
        if (s === 'open') {
          client
            .history('chat.message', Math.min(200, CHAT_LIMIT))
            .then((events) => dispatch({ kind: 'backfill', events }))
            .catch(() => {});
        }
      }),
      client.on('obs.', onEvent),
      client.on('platform.', onEvent),
      client.on('chat.', onEvent),
      client.on('show.feature.', onEvent),
      client.on('connections.', onEvent),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return state;
}
```

`apps/dashboard/src/components/ChatPanel.tsx`:
```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, Platform } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';

type Props = {
  messages: ChatMessage[];
  featuredId: string | null;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
};

export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 40) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function Fragment({ f }: { f: ChatMessage['fragments'][number] }) {
  switch (f.kind) {
    case 'text':
      return <>{f.text}</>;
    case 'mention':
      return <strong className="mention">@{f.name}</strong>;
    case 'link':
      return <>{f.url}</>;
    case 'emote': {
      const src = safeHttpsUrl(f.url);
      return src ? <img className="emote" src={src} alt={f.name} title={f.name} /> : <>{f.name}</>;
    }
  }
}

export function ChatPanel({ messages, featuredId, onFeature, onClearFeature }: Props) {
  const [hidden, setHidden] = useState<Set<Platform>>(new Set());
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const list = useRef<HTMLOListElement>(null);
  const lastCount = useRef(messages.length);

  const visible = messages.filter((m) => !hidden.has(m.platform));

  useLayoutEffect(() => {
    const added = Math.max(0, messages.length - lastCount.current);
    lastCount.current = messages.length;
    if (pinned && list.current) list.current.scrollTop = list.current.scrollHeight;
    else if (added) setUnseen((n) => n + added);
  }, [messages, pinned]);

  useEffect(() => {
    if (pinned) setUnseen(0);
  }, [pinned]);

  const toggle = (p: Platform) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <section className="panel chat">
      <div className="chat-head">
        <h2>Chat</h2>
        <div className="filters">
          {(Object.keys(PLATFORMS) as Platform[]).map((p) => (
            <button
              key={p}
              className={hidden.has(p) ? 'filter off' : 'filter'}
              style={{ borderColor: PLATFORMS[p].color }}
              aria-pressed={!hidden.has(p)}
              onClick={() => toggle(p)}
            >
              {PLATFORMS[p].label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 && <p className="muted">No messages yet. Connect a platform on the Connections page.</p>}
      <ol className="chat-list" ref={list} onScroll={(e) => setPinned(isNearBottom(e.currentTarget))}>
        {visible.map((m) => (
          <li key={m.id} className={m.id === featuredId ? 'chat-row featured' : 'chat-row'}>
            <span className="tag" style={{ background: PLATFORMS[m.platform].color }}>
              {PLATFORMS[m.platform].label}
            </span>
            <span className="author" style={m.author.color ? { color: m.author.color } : undefined}>
              {m.author.name}
            </span>
            {m.author.roles.map((r) => (
              <span key={r} className="role">
                {r}
              </span>
            ))}
            <span className="text">
              {m.fragments.map((f, i) => (
                <Fragment key={i} f={f} />
              ))}
            </span>
            {m.id === featuredId ? (
              <button className="feature" onClick={onClearFeature}>
                Unfeature
              </button>
            ) : (
              <button className="feature" onClick={() => onFeature(m)}>
                Feature
              </button>
            )}
          </li>
        ))}
      </ol>
      {!pinned && (
        <button
          className="jump"
          onClick={() => {
            if (list.current) list.current.scrollTop = list.current.scrollHeight;
            setPinned(true);
          }}
        >
          Paused · {unseen} new · Jump to latest
        </button>
      )}
    </section>
  );
}
```

In `apps/dashboard/src/App.tsx`, import `ChatPanel` and replace the placeholder `<section className="panel">…Unified chat arrives in M2…</section>` with:
```tsx
        <ChatPanel
          messages={state.chat}
          featuredId={state.featuredId}
          onFeature={(message) => client.publish('show.feature.set', { message })}
          onClearFeature={() => client.publish('show.feature.clear')}
        />
```

Append to `apps/dashboard/src/styles.css`:
```css
.chat { display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 140px); }
.chat-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.filters { display: flex; gap: 6px; }
.filter { padding: 4px 10px; font-size: 12px; border: 1px solid; background: transparent; }
.filter.off { opacity: 0.4; }
.chat-list { list-style: none; margin: 8px 0 0; padding: 0; overflow-y: auto; flex: 1; }
.chat-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 6px 4px; border-bottom: 1px solid #222632; overflow-wrap: anywhere; }
.chat-row.featured { background: #2b2550; }
.tag { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; color: #fff; }
.author { font-weight: 600; }
.role { font-size: 10px; text-transform: uppercase; color: var(--muted); border: 1px solid #333; border-radius: 4px; padding: 0 4px; }
.text { flex-basis: 100%; }
.emote { height: 1.6em; vertical-align: middle; }
.mention { color: var(--accent); }
.feature { margin-left: auto; padding: 2px 8px; font-size: 12px; }
.jump { margin-top: 8px; align-self: center; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/dashboard test && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(dashboard): unified chat with platform filters, safe rendering, backfill and Feature"
```

---

### Task 12: Dashboard Connections page

**Files:**
- Create: `apps/dashboard/src/components/ConnectionsPanel.tsx`, `apps/dashboard/src/components/ConnectionsPanel.test.tsx`
- Modify: `apps/dashboard/src/App.tsx`, `apps/dashboard/src/styles.css`

**Interfaces:**
- Consumes: `ConnectionState`, `Platform`; `safeHttpsUrl`, `PLATFORMS` (Task 11).
- Produces: `<ConnectionsPanel connections onConnect(platform) onDisconnect(platform) onSetYoutubeClient(clientId, clientSecret) />`, and a header toggle between "Show" and "Connections" in `App`.

- [ ] **Step 1: Write the failing tests**

`apps/dashboard/src/components/ConnectionsPanel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPanel } from './ConnectionsPanel';

afterEach(cleanup);

const handlers = () => ({ onConnect: vi.fn(), onDisconnect: vi.fn(), onSetYoutubeClient: vi.fn() });

describe('ConnectionsPanel', () => {
  it('shows the Twitch code and activation link while pending', () => {
    render(
      <ConnectionsPanel
        connections={{ twitch: { platform: 'twitch', state: 'pending', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' } }}
        {...handlers()}
      />,
    );
    expect(screen.getByText('ABCDEFGH')).toBeTruthy();
    const link = screen.getByRole('link', { name: /twitch\.tv\/activate/ });
    expect(link.getAttribute('href')).toBe('https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('connects and disconnects Twitch', () => {
    const h = handlers();
    const { rerender } = render(<ConnectionsPanel connections={{ twitch: { platform: 'twitch', state: 'disconnected' } }} {...h} />);
    fireEvent.click(within(screen.getByTestId('conn-twitch')).getByRole('button', { name: 'Connect' }));
    expect(h.onConnect).toHaveBeenCalledWith('twitch');
    rerender(<ConnectionsPanel connections={{ twitch: { platform: 'twitch', state: 'connected', account: 'yatf' } }} {...h} />);
    expect(screen.getByText('yatf')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('conn-twitch')).getByRole('button', { name: 'Disconnect' }));
    expect(h.onDisconnect).toHaveBeenCalledWith('twitch');
  });

  it('asks for the YouTube client, submits trimmed values and clears the secret field', () => {
    const h = handlers();
    render(<ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'disconnected', clientConfigured: false } }} {...h} />);
    const id = screen.getByLabelText('Client ID') as HTMLInputElement;
    const secret = screen.getByLabelText('Client secret') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(id, { target: { value: ' cid ' } });
    fireEvent.change(secret, { target: { value: ' s3 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }));
    expect(h.onSetYoutubeClient).toHaveBeenCalledWith('cid', 's3');
    expect(secret.value).toBe('');
  });

  it('links the Google sign-in only when it is https', () => {
    const { rerender } = render(
      <ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } }} {...handlers()} />,
    );
    expect(screen.getByRole('link', { name: 'Continue to Google sign-in' }).getAttribute('href')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    rerender(
      <ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: 'javascript:alert(1)' } }} {...handlers()} />,
    );
    expect(screen.queryByRole('link', { name: 'Continue to Google sign-in' })).toBeNull();
  });

  it('shows errors and the YouTube policy links', () => {
    render(<ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'error', detail: 'YouTube sign-in expired. Reconnect YouTube on the Connections page.' } }} {...handlers()} />);
    expect(screen.getByText(/sign-in expired/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'YouTube Terms of Service' }).getAttribute('href')).toBe('https://www.youtube.com/t/terms');
    expect(screen.getByRole('link', { name: 'Google Privacy Policy' }).getAttribute('href')).toBe('https://policies.google.com/privacy');
  });

  it('marks Kick as coming later', () => {
    render(<ConnectionsPanel connections={{ kick: { platform: 'kick', state: 'disconnected', detail: 'Kick arrives with the relay (M3).' } }} {...handlers()} />);
    expect(within(screen.getByTestId('conn-kick')).getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @streamhub/dashboard exec vitest run src/components/ConnectionsPanel.test.tsx`
Expected: FAIL, `./ConnectionsPanel` not found.

- [ ] **Step 3: Implement**

`apps/dashboard/src/components/ConnectionsPanel.tsx`:
```tsx
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ConnectionState, Platform } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';

type Props = {
  connections: Partial<Record<Platform, ConnectionState>>;
  onConnect: (platform: Platform) => void;
  onDisconnect: (platform: Platform) => void;
  onSetYoutubeClient: (clientId: string, clientSecret: string) => void;
};

const ExternalLink = ({ href, children }: { href: string; children: string }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

function Row({ platform, state, children, onConnect, onDisconnect, disabled }: {
  platform: Platform;
  state: ConnectionState | undefined;
  children?: ReactNode;
  onConnect: () => void;
  onDisconnect: () => void;
  disabled?: boolean;
}) {
  const s = state?.state ?? 'disconnected';
  return (
    <div className="conn" data-testid={`conn-${platform}`}>
      <div className="conn-head">
        <span className="tag" style={{ background: PLATFORMS[platform].color }}>
          {PLATFORMS[platform].label}
        </span>
        <span className={`conn-state ${s}`}>{s}</span>
        {state?.account && <strong>{state.account}</strong>}
        <span className="spacer" />
        {s === 'connected' ? (
          <button onClick={onDisconnect}>Disconnect</button>
        ) : (
          <button className="primary" onClick={onConnect} disabled={disabled || s === 'pending'}>
            Connect
          </button>
        )}
      </div>
      {state?.detail && <p className={s === 'error' ? 'conn-error' : 'muted'}>{state.detail}</p>}
      {children}
    </div>
  );
}

function YouTubeClientForm({ onSave }: { onSave: (id: string, secret: string) => void }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !secret.trim()) return;
    onSave(id.trim(), secret.trim());
    setSecret('');
  };
  return (
    <form className="yt-client" onSubmit={submit}>
      <p className="muted">
        YouTube needs your own Google OAuth client (about 5 minutes, see <code>docs/setup/youtube.md</code>). It is
        stored only on this computer.
      </p>
      <label>
        Client ID
        <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Client secret
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
      </label>
      <button type="submit">Save client</button>
    </form>
  );
}

export function ConnectionsPanel({ connections, onConnect, onDisconnect, onSetYoutubeClient }: Props) {
  const [editClient, setEditClient] = useState(false);
  const twitch = connections.twitch;
  const youtube = connections.youtube;
  const activate = twitch?.state === 'pending' ? safeHttpsUrl(twitch.verificationUri) : null;
  const google = youtube?.state === 'pending' ? safeHttpsUrl(youtube.authUrl) : null;
  const showClientForm = editClient || youtube?.clientConfigured === false;

  return (
    <section className="panel connections">
      <h2>Connections</h2>

      <Row platform="twitch" state={twitch} onConnect={() => onConnect('twitch')} onDisconnect={() => onDisconnect('twitch')}>
        {twitch?.state === 'pending' && twitch.userCode && (
          <p>
            Go to {activate ? <ExternalLink href={activate}>{activate.replace(/^https:\/\//, '').split('?')[0]!}</ExternalLink> : 'twitch.tv/activate'} and enter{' '}
            <code className="code">{twitch.userCode}</code>
          </p>
        )}
      </Row>

      <Row platform="youtube" state={youtube} onConnect={() => onConnect('youtube')} onDisconnect={() => onDisconnect('youtube')}>
        {google && (
          <p>
            <ExternalLink href={google}>Continue to Google sign-in</ExternalLink>
          </p>
        )}
        {showClientForm ? (
          <YouTubeClientForm
            onSave={(id, secret) => {
              onSetYoutubeClient(id, secret);
              setEditClient(false);
            }}
          />
        ) : (
          <button className="link" onClick={() => setEditClient(true)}>
            Change Google client
          </button>
        )}
        <p className="muted small">
          By connecting YouTube you agree to the <ExternalLink href="https://www.youtube.com/t/terms">YouTube Terms of Service</ExternalLink>. See
          the <ExternalLink href="https://policies.google.com/privacy">Google Privacy Policy</ExternalLink>. Chat is kept in memory only.
        </p>
      </Row>

      <Row platform="kick" state={connections.kick} onConnect={() => onConnect('kick')} onDisconnect={() => onDisconnect('kick')} disabled />
    </section>
  );
}
```

In `apps/dashboard/src/App.tsx`:
- import `useState` from `react` and `ConnectionsPanel`
- add `const [view, setView] = useState<'show' | 'connections'>('show');` at the top of `App`
- in `<header>`, after `<h1>`, add:
```tsx
        <nav className="tabs">
          <button aria-pressed={view === 'show'} onClick={() => setView('show')}>Show</button>
          <button aria-pressed={view === 'connections'} onClick={() => setView('connections')}>Connections</button>
        </nav>
```
- wrap the existing `<main>…</main>` as `{view === 'show' ? (<main>…</main>) : (<main className="single"><ConnectionsPanel … /></main>)}`, with:
```tsx
          <ConnectionsPanel
            connections={state.connections}
            onConnect={(platform) => client.publish('connections.cmd.connect', { platform })}
            onDisconnect={(platform) => client.publish('connections.cmd.disconnect', { platform })}
            onSetYoutubeClient={(clientId, clientSecret) => client.publish('connections.cmd.setYoutubeClient', { clientId, clientSecret })}
          />
```

Append to `apps/dashboard/src/styles.css`:
```css
.tabs { display: flex; gap: 4px; margin-right: auto; margin-left: 16px; }
.tabs button[aria-pressed='true'] { background: var(--accent); }
main.single { grid-template-columns: minmax(0, 720px); }
.conn { border-top: 1px solid #222632; padding: 12px 0; }
.conn-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.conn-state { font-size: 12px; text-transform: uppercase; color: var(--muted); }
.conn-state.connected { color: var(--ok); }
.conn-state.error { color: var(--danger); }
.conn-error { color: var(--danger); }
.spacer { flex: 1; }
.code { font-size: 20px; letter-spacing: 0.15em; padding: 2px 8px; background: #262a35; border-radius: 6px; }
.yt-client { display: grid; gap: 8px; max-width: 480px; }
.yt-client label { display: grid; gap: 4px; font-size: 13px; }
.yt-client input { font: inherit; padding: 8px; border-radius: 6px; border: 1px solid #333; background: #11131a; color: var(--text); }
button.link { background: none; padding: 0; color: var(--accent); text-decoration: underline; }
.small { font-size: 12px; }
a { color: var(--accent); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @streamhub/dashboard test && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(dashboard): Connections page for Twitch device code and YouTube BYO client"
```

---

### Task 13: Setup guides, docs, browser check and acceptance

**Files:**
- Create: `docs/setup/twitch.md`, `docs/setup/youtube.md`
- Modify: `README.md`, `docs/go-live.md`, `ARCHITECTURE.md`, `TASKS.md`

**Interfaces:**
- Consumes: the running system.
- Produces: docs only, plus a recorded manual check.

- [ ] **Step 1: Write `docs/setup/twitch.md`**
```markdown
# Connect Twitch

streamhub reads your chat with Twitch's EventSub and signs you in with a device code. No password or secret is stored in streamhub, and the token stays on this computer.

## One-time: register a Twitch app (2 minutes)
1. Go to https://dev.twitch.tv/console (2FA must be enabled on your Twitch account) → **Register Your Application**.
2. Name: anything unique, e.g. `streamhub-<yourname>`. OAuth Redirect URL: `http://localhost` (required by the form, not used). Category: **Application Integration**.
3. **Client Type: Public.** This lets streamhub sign in without a secret.
4. Create, then copy the **Client ID** into `.env`:
   ```
   TWITCH_CLIENT_ID=your_client_id
   ```
5. Restart streamhub.

Each person or fork registers their own app; Twitch asks apps not to share client IDs.

## Connect
Dashboard → **Connections** → Twitch → **Connect**. Open the link, enter the code shown, and approve. The row turns **connected** with your login.

streamhub re-checks the login every hour, as Twitch requires. If it expires or you revoke access, the row says so; press **Connect** again.
```

- [ ] **Step 2: Write `docs/setup/youtube.md`**
```markdown
# Connect YouTube (bring your own Google project)

YouTube's API policy forbids open-source apps from shipping API credentials, and quota is counted per Google project. So you create your own free project once (about 5 minutes). That also gives you your own 10,000 units/day of quota.

## One-time: create your Google OAuth client
1. https://console.cloud.google.com → project picker → **New project** (e.g. `streamhub`).
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **Google Auth Platform** (OAuth consent screen) → **Get started**. App name `streamhub`, your email as support and developer contact. Audience: **External**.
4. **Audience → Test users → Add users**: add the Google account that owns your YouTube channel.
5. **Clients → Create client** → Application type **Desktop app** → Create. Copy the **Client ID** and **Client secret**.

## Connect
Dashboard → **Connections** → YouTube → paste the Client ID and Client secret → **Save client** → **Connect** → **Continue to Google sign-in**.
- Google warns that the app isn't verified. It's your own app: choose **Continue**.
- Grant "View your YouTube account" (read-only).
- The tab says "YouTube is connected", and the row shows your channel name.

## Good to know
- **7-day sign-in limit:** while your consent screen is in **Testing**, Google expires the sign-in after 7 days, and streamhub will ask you to reconnect. To avoid it, set the app to **In production** (Audience → Publish app). You'll still see the "unverified" warning, but only you use it.
- **When you're not live,** the YouTube row says *offline*, and streamhub checks for a broadcast once a minute (1 quota unit each).
- **Deleted messages:** YouTube no longer reports deletions, so a message removed by a moderator may stay in the dashboard.
- **Privacy:** your client secret and tokens live only in `.streamhub/secrets.json` on this computer. Never commit or share them. Chat is kept in memory, not saved.
```

- [ ] **Step 3: Update the other docs**
- `README.md`: add a step after the Setup list's step 3: `4. Connect chat: docs/setup/twitch.md and docs/setup/youtube.md (then Dashboard → Connections).` Renumber the multistream step to 5.
- `docs/go-live.md`: replace `(Chat checks are added here in M2 and M3.)` with:
```markdown
Chat:
1. Dashboard → Connections: Twitch and YouTube show **connected**.
2. Status bar: `twitch: live` once connected; `youtube: live` once your broadcast is live (it says `offline` before that).
3. Send a test message from each platform: both appear in the Chat panel within ~2 s, tagged Twitch / YouTube.
4. Delete a Twitch message as moderator: it disappears from the dashboard.
```
- `ARCHITECTURE.md` connectors table: Twitch row notes → `EventSub WS + Device Code Flow (docs/setup/twitch.md)`; YouTube row notes → `streamList gRPC, polling fallback; BYO Google project (docs/setup/youtube.md)`.
- `TASKS.md`: mark `- [x] M2 Direct chat: Twitch + YouTube (\`plans/2026-10-01-streamhub-m2-chat.md\`); live acceptance pending`.

- [ ] **Step 4: Browser check (no real accounts needed)**

Run `pnpm dev` and open http://127.0.0.1:5173 with a browser automation tool. Check:
- The **Show** view has a Chat panel with Twitch/YouTube/Kick filters and "No messages yet…".
- The **Connections** view shows:
  - Twitch: disconnected, with the `TWITCH_CLIENT_ID` hint when unset.
  - YouTube: the client form.
  - Kick: Connect disabled.
- Saving a dummy YouTube client switches it to a **Connect** button. Pressing it shows a **Continue to Google sign-in** link to `accounts.google.com`. Don't complete the sign-in.

Stop the dev servers. Then remove the dummy client by deleting `.streamhub/secrets.json`.

- [ ] **Step 5: Live acceptance (needs your accounts; record the result)**

Follow `docs/setup/twitch.md` and `docs/setup/youtube.md`, then `docs/go-live.md` "Chat".
Expected: messages from both platforms merge within ~2 s, and killing the network for one platform doesn't affect the other.
Record the date and result under `## Verified` in `docs/go-live.md`. Also record the YouTube quota used per hour of streamList (Cloud Console → APIs → YouTube Data API v3 → Quotas), because the research doc lists that as an open question.

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "docs: Twitch and YouTube setup guides, chat go-live checks"
```
