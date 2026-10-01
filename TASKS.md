# TASKS.md — build order for the base

Scope of the base: **stream control + unified chat + scene transitions.** Each milestone ends runnable with `pnpm dev`.

## M0 — Skeleton
- [ ] pnpm workspace with `apps/hub`, `apps/dashboard`, `packages/shared`, `packages/overlay-sdk`, `modules/`.
- [ ] TypeScript strict, ESLint, Prettier, Vitest wired at root.
- [ ] `packages/shared`: envelope + all types/zod schemas from `EVENTS.md`.
- [ ] `.env.example`, `config/` folder, README with setup steps.
- **Done when:** `pnpm dev` starts hub on 127.0.0.1:4747 and serves an empty dashboard.

## M1 — Bus + OBS bridge + scenes
- [ ] In-process bus + WebSocket server with `subscribe/unsubscribe/publish/history` ops and schema validation.
- [ ] `overlay-sdk`: `connect()`, `on()`, `publish()`, auto-reconnect.
- [ ] OBS bridge: connect/reconnect, emit `obs.connection`, `obs.scenes.list`, `obs.scene.changed`, `obs.stream.state`; handle `obs.cmd.*`.
- [ ] Dashboard: scene buttons, current scene, stream start/stop with confirm, status bar.
- **Done when:** clicking a scene in the dashboard switches OBS; starting/stopping the stream works; killing OBS shows "disconnected" and reconnects when it's back.

## M2 — Unified chat
- [ ] Spike + write `docs/connectors/twitch.md`, then Twitch connector.
- [ ] Spike + write `docs/connectors/youtube.md` (quota math included), then YouTube connector.
- [ ] Normalizer tests with recorded fixture payloads per platform.
- [ ] Dashboard unified chat: platform tags/colors, emotes, platform filter, auto-scroll with "paused" state when scrolled up, backfill on reload.
- [ ] "Feature" action → `show.feature.set`.
- **Done when:** messages from Twitch and YouTube appear in one feed within ~2s, one platform failing doesn't affect the other.

## M3 — Modules + transitions
- [ ] Module discovery, manifest validation, static serving at `/m/<id>/`, per-module permission enforcement, session token injection.
- [ ] `modules/chat-overlay`: on-screen chat, transparent background, max N lines, fades old messages.
- [ ] `modules/featured-message`: animates in on `show.feature.set`, out on `show.feature.clear`.
- [ ] `modules/transition-wipe`: full-screen overlay transition driven by `show.transition.play`.
- [ ] Hub transition runner: plays overlay transition, cuts scene at `midpointMs`, emits `show.transition.done` (timeout fallback if the overlay never answers).
- **Done when:** all three modules work as OBS Browser Sources and a wipe transition cleanly hides the scene cut.

## M4 — Sequencer
- [ ] Load `config/sequences/*.json` with validation; `do` / `wait` / `waitFor` steps; cancel.
- [ ] Dashboard: sequence buttons with running/step state.
- [ ] Ship `stream-intro` and `stream-outro` example sequences.
- **Done when:** one click runs Starting Soon → start stream → countdown → wipe to Main Cam.

## M5 — Kick + desktop shell (after the base is proven on a real stream)
- [ ] Kick spike: document whether real-time chat is possible without a public webhook; implement the chosen path.
- [ ] Tauri 2 shell wrapping dashboard + hub (hub as sidecar), tokens in OS keychain, in-app OAuth.

## Later (live-coded modules, not part of the base)
Teleprompter/script view · roast-o-meter · karaoke song picker · hackathon voting · average-ness score · fake-money bets · chat-triggered sounds.
