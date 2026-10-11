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

## Record your show
One press of Record gives you everything to cut a video afterwards, all encoded by OBS:
- the program recording: the picture the stream shows, with the stream mix on audio track 1 and each mic alone on tracks 2–6,
- one video file per camera,
- optionally a recording on the camera's own card (GoPro).

Set up the mics with [docs/audio/mics.md](docs/audio/mics.md), the cameras with [docs/cameras/](docs/cameras/), and recording with [docs/setup/recording.md](docs/setup/recording.md).

## Turn the recordings into YouTube videos
streamhub gets the show recorded. [Vanpelt Studio](https://vanpelt.studio) helps with what comes next: it works like an expert YouTube team, finding the videos your audience already wants, then helping you script, shoot, check and package every one (titles and thumbnails included). You edit in whatever editor you like.

## Docs
`CLAUDE.md` (rules), `ARCHITECTURE.md`, `EVENTS.md` (event contract), `docs/superpowers/specs/` (design), `docs/go-live.md` (pre-show checklist).

## License
Copyright © 2026 VanpeltVentures Pte Ltd. streamhub is free software under the [GNU Affero General Public License v3.0](LICENSE): you can use, change and share it, but if you distribute a modified version or run one as a service for others, you must publish its source under the same license.
