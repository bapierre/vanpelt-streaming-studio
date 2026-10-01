# CLAUDE.md — streamhub

> Working name: `streamhub`. Rename freely; nothing depends on it.

## What this is
An open-source, local-first control hub for a live show ("Your Average Tech Founder").
It sits **next to OBS, never replaces it**. OBS encodes and streams; streamhub:

1. pulls chat from every platform into one normalized feed,
2. drives OBS (scenes, transitions, start/stop stream) over obs-websocket,
3. serves overlays as web pages that OBS loads as Browser Sources,
4. hosts **modules** — small self-contained overlay apps (built live on stream) that react to chat and show events.

Read `ARCHITECTURE.md` for the design, `EVENTS.md` for the event contract, `TASKS.md` for what to build and in what order.

## Hard rules
- **Never encode or send video.** Everything video goes through OBS.
- **Bind to 127.0.0.1 only.** No LAN or public exposure unless a task explicitly says so.
- **All platform data is normalized** into the types in `EVENTS.md` before it touches the bus. Nothing downstream may read `raw` except for debugging.
- **Modules only talk to the hub through the event bus** (WebSocket). No module imports hub code.
- **Secrets live in `.env` (v0)**, which is gitignored. Never log tokens. `.env.example` lists every key with an empty value.
- **Connectors must fail soft:** one platform going down never crashes the hub; it emits `platform.status` and retries with backoff.
- Before implementing any platform connector, **check the platform's current official API docs** (see "Verify before building" in `ARCHITECTURE.md`). Do not rely on remembered endpoints.

## Stack
- TypeScript everywhere, Node 20+, pnpm workspaces.
- Hub: Fastify + `ws`, `obs-websocket-js` (v5 protocol), `zod` for validation.
- Dashboard + overlays: React + Vite.
- Tests: Vitest. Lint: ESLint + Prettier.
- Desktop shell (Tauri 2) comes **after** the base works — see `TASKS.md` M5.

## Repo layout
```
apps/
  hub/          # Node process: bus, connectors, OBS bridge, HTTP/WS server
  dashboard/    # React control panel (unified chat, scenes, sequences, status)
packages/
  shared/       # event types + zod schemas (single source of truth)
  overlay-sdk/  # tiny client lib modules use to connect to the bus
modules/
  chat-overlay/       # reference module: on-screen chat
  featured-message/   # reference module: pinned chat message
  transition-wipe/    # reference module: overlay-driven scene transition
```

## Conventions
- Event names: `domain.action` (`chat.message`, `obs.scene.changed`).
- One connector per platform in `apps/hub/src/connectors/<platform>.ts`, each implementing the `Connector` interface.
- Every new event type is added to `packages/shared` first (type + zod schema), then used.
- Small commits; each milestone in `TASKS.md` ends with a runnable state.

## Definition of done (per task)
Runs with `pnpm dev`, has at least one test for its logic, handles the disconnected case, and is documented in the relevant `.md` if it changes a contract.
