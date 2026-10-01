# streamhub base — design spec

Date: 2026-10-01 · Status: approved 2026-10-01

This spec **amends** `CLAUDE.md`, `ARCHITECTURE.md`, `EVENTS.md` and `TASKS.md`. Where it disagrees with them, this spec wins, and those files get updated in the first implementation milestone.

## 1. Intent

- **Outcome:** an open-source, local-first tool that runs the "Your Average Tech Founder" live show. It goes live on several platforms at once and merges every platform's chat into one UI you watch during the stream.
- **Audience:** you first, then other streamers, including non-developers. Each person assembles their own setup by turning connectors and modules on or off. No one has to code or deploy anything.
- **Later:** fun features (overlays, transitions, sequencer, games) arrive as optional modules, built live on stream. They are not part of the base.
- **Success for the base:** you can run a real show with it. One click starts the stream on Twitch, YouTube, Kick and X. Chat from Twitch, YouTube and Kick appears in one feed within ~2 s (X chat is deferred, see §9). A platform failing never takes the others down.

## 2. Scope

**In the base**
1. Hub: event bus, WebSocket API, OBS bridge (scenes, start/stop, status).
2. Multistream: Twitch, YouTube, Kick and X destinations, started and stopped together.
3. Chat connectors: Twitch and YouTube (direct from the hub); Kick (through the relay). **X chat is deferred** (video to X is still in).
4. **Relay:** a hosted, self-hostable cloud service that receives Kick webhooks and does Kick OAuth. It is built platform-agnostic so other webhook-only platforms can be added later.
5. Dashboard: unified chat, scene buttons, start/stop, status bar, connections/settings page.
6. Module host: discovery, serving and permissions, so modules can be built live later. No reference modules are required.

**Moved out of the base** (become modules or later work): overlay transitions + `transition-wipe`, `chat-overlay`, `featured-message`, sequencer, teleprompter, Tauri shell.

`show.feature.set` stays in the contract so the "Feature" button in the dashboard keeps working once a module listens for it.

## 3. Customisation model ("assemble your own tool")

**Install and toggle at runtime.** Everyone runs the same streamhub.
- `config/streamhub.json` (committed defaults, user-editable) lists enabled connectors and enabled modules.
- The dashboard Settings page toggles them and writes the file; the hub applies changes without a restart (connectors stop/start; modules are re-scanned).
- To add a module, drop a folder into `modules/`. A module registry/installer is out of scope.

## 4. Architecture

```
                         ┌──────────── cloud (yours, or self-hosted) ───────────┐
 Kick ──webhook─────────▶│  relay (Cloudflare Worker)                           │
 (more platforms later)  │   /webhooks/:platform          → verify signature    │
                         │   /connect/:platform           → OAuth (holds secrets)│
                         │   StreamerSession Durable Object (1 per streamer)    │
                         └──────────────────────┬───────────────────────────────┘
                                                │ wss (opened BY the hub, outbound)
 Twitch (EventSub WS) ─┐                        │
 YouTube (API)  ───────┼─▶ connectors ─▶ normalizer ─▶ BUS ─▶ dashboard / modules
 relay connector ──────┘                                 └──▶ OBS bridge ◀▶ OBS + multi-rtmp
```

The hub still binds to 127.0.0.1 only. It never accepts inbound internet traffic; the relay connection is outbound.

### 4.1 Hub
Unchanged from `ARCHITECTURE.md` §1–3 except:
- Port **4747** everywhere (fix the `4455` example).
- `Platform` stays `'twitch' | 'youtube' | 'kick'`.
- A new connector, `relay`, implements `Connector` once and emits normalized messages for every relay-backed platform (Kick in v0). It reports one `platform.status` per platform.
- Origin check: allow the hub's own origin (`http://127.0.0.1:4747`). That is also what OBS Browser Sources send, because overlays are served by the hub. Drop the special `null` case; the session token is still required for modules.

### 4.2 Multistream
- OBS's main output streams to one platform (your choice; Twitch recommended). The **obs-multi-rtmp** plugin (GPL-2.0, installed separately, never bundled) handles the others, with **"Sync start with OBS" + "Sync stop with OBS"** ticked on every target.
- The hub's `obs.cmd.startStream` / `stopStream` therefore controls every destination.
- **Known limit:** multi-rtmp exposes no remote API, so the hub only sees the main output's state. Per-target health stays in the plugin's dock in OBS. Possible follow-up: upstream a PR adding obs-websocket vendor requests to multi-rtmp.
- The README gets a setup guide: install the plugin, add one target per platform (X key from Media Studio Producer → Sources), tick both sync boxes.

### 4.3 Relay (`apps/relay`)
Cloudflare Worker + Durable Objects + D1, TypeScript, in the same monorepo.

**Identity and pairing**
1. In the dashboard, the streamer clicks *Connect Kick*. The hub opens the browser at `RELAY_URL/connect/kick?redirect=http://127.0.0.1:4747/relay/callback&state=<nonce>`.
2. The relay runs the platform OAuth with **its** client id and secret. It creates (or finds) a relay account keyed by the platform user id, stores the encrypted refresh token, and creates the platform webhook subscription for chat.
3. The relay redirects to the loopback callback with a short-lived code. The hub exchanges that code for a long-lived **hub token** and stores it in `.env.local` (OS keychain later, with Tauri).
4. Connecting a second platform while signed in links it to the same relay account.
- *Disconnect* in the dashboard revokes the platform token, deletes the subscription and deletes the stored credentials.

**Delivery**
- The hub opens `wss://RELAY_URL/session` with its hub token. That connection lands on the streamer's `StreamerSession` Durable Object.
- Webhooks arrive at `/webhooks/:platform`. The relay verifies the platform signature (Kick: RSA public-key signature; exact scheme confirmed in the Kick spike), maps the broadcaster id to the relay account and forwards the **raw** payload to that Durable Object.
- The Durable Object pushes `{platform, receivedAt, payload}` to the connected hub. **Normalization happens in the hub**, so all normalizers live in one place, tested the same way.
- If the hub is offline, the Durable Object keeps the last 100 events in memory for 5 minutes and replays them on reconnect. Nothing is persisted. Chat content is never written to disk or logs.

**Storage (D1):** accounts, platform links (encrypted refresh tokens with AES-GCM, key held in a Worker secret), hub tokens (hashed), subscription ids. That is all.

**Abuse and cost controls (in from day one)**
- Per-account rate limit on forwarded events and on connect attempts.
- An admin kill switch per account and globally (env flag).
- Usage counters per account (events per day), so a fee can be introduced later with real numbers. Payment is out of scope.

**Self-hosting:** `pnpm --filter relay deploy` with your own Kick app. The hub just changes `RELAY_URL`.

**Legal:** a short privacy policy and terms page served by the relay (Kick app registration needs them anyway).

### 4.4 Connectors
| Platform | Path | Spike output |
|---|---|---|
| Twitch | Hub-direct, EventSub WebSocket (`channel.chat.message`, `message_delete`, `clear`, `clear_user_messages`). Device Code Flow with a **Public** client: no secret; client id via `TWITCH_CLIENT_ID` | `docs/connectors/twitch.md` |
| YouTube | Hub-direct. `liveChatMessages.streamList` (gRPC) with `liveChatMessages.list` polling as fallback; broadcast found via `liveBroadcasts.list` (`broadcastStatus=active`, `broadcastType=all`). Loopback OAuth + PKCE, scope `youtube.readonly`, **bring-your-own Google Cloud project** (see §4.6) | `docs/connectors/youtube.md`, `docs/connectors/youtube-stream_list.proto` |
| Kick | Relay, official webhooks `chat.message.sent` | `docs/connectors/kick.md` |

**Kick fallback:** an opt-in `kick-pusher` connector reads Kick's public web-client WebSocket. It is off by default and clearly labelled unofficial. It is used only if the relay is unavailable.

**X chat (deferred):** chat needs X's Livestream API, which is approval-only and Enterprise-plan, with per-event webhook billing that is unpublished for chat (estimated $120–700/month per streamer if priced like similar events). Not built in v0. Findings are recorded in `docs/connectors/x.md`. Revisit as a self-hosted, "bring your own X app" relay platform, or on the shared relay if X confirms low pricing.

### 4.6 Connections, credentials and secrets (amended 2026-10-01, M2)
- **Secrets store:** `.streamhub/secrets.json` at the repo root (gitignored), mode `0600`, written atomically (temp file + rename). It holds platform tokens and BYO YouTube client credentials, and moves to the OS keychain with Tauri. Secrets are never published on the bus or logged.
- **Connect flows are bus commands**, so they reuse the WebSocket origin checks: the dashboard publishes `connections.cmd.*`, and the hub answers with retained `connections.state` events. The only new HTTP route is the YouTube OAuth loopback callback `GET /oauth/youtube/callback`, protected by `state` + PKCE.
- **Twitch:** Device Code Flow. The dashboard shows the code and a link to twitch.tv/activate. The hub refreshes on 401 (one-time refresh tokens, persisted atomically) and validates the token at startup and every hour.
- **YouTube (option C):**
  - **M2:** each streamer brings their own Google Cloud project and Desktop OAuth client (setup guide in `docs/setup/youtube.md`), and pastes the client id and secret into the Connections page.
  - **Later:** a "connect with one click" token source through the relay, once your project passes Google verification and the YouTube compliance audit. The connector takes a `TokenSource` interface so the source can be swapped.
- **YouTube policy obligations:** a YouTube icon on YouTube messages; links to the YouTube Terms of Service and Google Privacy Policy on the Connections page; chat kept in memory only (never persisted beyond 30 days); no derived chat metrics persisted.
- **Deletions:** Twitch deletions and clears are honoured. YouTube no longer reports deletions (2026-06-23), so removal is best effort there.

### 4.5 Dashboard
As in `ARCHITECTURE.md` §6, plus:
- **Connections page:** connect/disconnect per platform, with status and last error. Twitch and YouTube arrive in M2 (§4.6); Kick arrives with the relay in M3.
- **Settings page:** enable/disable connectors and modules (§3).
- **Chat:** three platform colours/icons and a filter for each.
- Stream start/stop shows a reminder: *"multi-rtmp targets follow OBS only if Sync start is enabled."*

## 5. Event contract changes (`EVENTS.md` + `packages/shared`)
- New `relay.connection` event: `{ connected: boolean; detail?: string }`.
- M2: `chat.cleared` `{ platform: Platform; authorId?: string }` (whole chat, or one user's messages); `connections.state` `{ platform; state: 'disconnected'|'pending'|'connected'|'error'; account?: string; detail?: string; userCode?: string; verificationUri?: string; authUrl?: string; clientConfigured?: boolean }` (retained per platform); commands `connections.cmd.connect {platform}`, `connections.cmd.disconnect {platform}`, `connections.cmd.setYoutubeClient {clientId, clientSecret}`.
- Hub ↔ relay protocol (in `packages/shared/relay.ts`):
  - relay → hub: `{ op: 'event', platform, receivedAt, payload }` and `{ op: 'status', platform, status, detail? }`
  - hub → relay: `{ op: 'ack', upTo }`, so replay only sends events after the last acknowledged one.

## 6. Error handling
- Every connector, including `relay`, fails soft: backoff from 1 s up to 60 s with jitter, plus a `platform.status` event.
- Relay unreachable: Kick shows `error: relay unreachable`; Twitch and YouTube are unaffected.
- Expired or revoked platform token: the relay emits `status: error, detail: 'reconnect required'`, and the dashboard shows a *Reconnect* button.
- Webhook with a bad signature: rejected with 401, counted, never forwarded.
- OBS down: as before (`obs.connection` false, reconnect loop).

## 7. Testing
- Normalizers: Vitest with recorded fixture payloads for each platform (three sets).
- Bus and WS ops: unit tests, including permission enforcement.
- Relay: Vitest with `@cloudflare/vitest-pool-workers`. Covers signature verification (valid/invalid), routing to the right Durable Object, replay buffer, rate limit and token encryption round-trip.
- OBS bridge: tests against a mocked `obs-websocket-js`.
- Manual go-live checklist in `docs/go-live.md`: private test stream to all four platforms (video), and a chat message from Twitch, YouTube and Kick shows up.

## 8. Revised milestones (replace `TASKS.md` M0–M4)
- **M0 Skeleton** — workspace (`apps/hub`, `apps/dashboard`, `apps/relay`, `packages/shared`, `packages/overlay-sdk`, `modules/`), tooling, shared types, docs amended per this spec.
- **M1 Bus + OBS + multistream** — bus/WS, overlay-sdk, OBS bridge, dashboard scenes/start/stop/status, multi-rtmp setup guide. *Done when:* one click goes live on all configured platforms (private test streams).
- **M2 Direct chat** — Twitch and YouTube connectors, secrets store, minimal Connections page (Twitch DCF, YouTube BYO client), unified chat UI, Feature button, setup guides. *Done when:* both feeds merge within ~2 s, and one platform failing doesn't affect the other.
- **M3 Relay + Kick** — relay worker, OAuth pairing, Kick webhooks, relay connector, Kick on the Connections page, privacy/terms, deploy. *Done when:* Kick chat appears in the feed via your hosted relay, and a self-hosted relay works with only `RELAY_URL` changed.
- **M4 Module host + settings** — module discovery, serving, permissions, Settings toggles. *Done when:* a hello-world module dropped into `modules/` loads as an OBS Browser Source and can be toggled off.

After the base: Tauri shell (keychain, packaged app for non-developers), then live-coded modules.

## 9. Open risks
1. **X chat deferred.** Enterprise/approval-only, pricing unconfirmed. Apply for access and ask X for chat pricing in parallel; no code depends on it.
2. **Kick webhook reliability** is unproven; the Pusher fallback covers it.
3. **Holding other people's tokens.** Encryption, revocation and a privacy policy are mandatory before inviting anyone else.
4. **multi-rtmp per-target status** is invisible to the hub (accepted for v0).
5. **Platform ToS** for relaying chat: each connector spike checks its platform's terms.
