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
