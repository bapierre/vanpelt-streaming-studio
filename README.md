# streamhub

Open-source, local-first control hub for live shows. It sits next to OBS: OBS encodes and streams (to several platforms via obs-multi-rtmp), and streamhub drives OBS and merges chat into one dashboard.

## Setup
1. Node 20+ and pnpm (`corepack enable`).
2. `pnpm install`
3. `cp .env.example .env` and fill `OBS_WS_PASSWORD` (OBS → Tools → WebSocket Server Settings → Enable, Show Connect Info), or enter it later in the dashboard under Settings → OBS.
4. Connect chat: `docs/setup/twitch.md` and `docs/setup/youtube.md` (then Settings → Platforms; the gear button or ⌘, opens Settings).
5. Multistreaming: follow `docs/multistream.md`.

## Run
- Development: `pnpm dev`, then open http://127.0.0.1:5173
- Production-like: `pnpm build && pnpm start`, then open http://127.0.0.1:4747
- Desktop: `pnpm desktop:dev` (requires Rust and the native build tools for Tauri 2). Close the window to stop its hub.
- Package desktop: `pnpm desktop:build`. The app bundles Node, the hub, and the dashboard; no Node installation is needed to run it. See [desktop setup](docs/desktop.md).

## Docs
`CLAUDE.md` (rules), `ARCHITECTURE.md`, `EVENTS.md` (event contract), `docs/superpowers/specs/` (design), `docs/go-live.md` (pre-show checklist).
