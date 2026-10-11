# streamhub

Open-source, local-first control hub for live shows. It sits next to OBS: OBS encodes and streams (to several platforms via obs-multi-rtmp), and streamhub drives OBS and merges chat into one dashboard.

streamhub is a free tool hosted by [Vanpelt Studio](https://vanpelt.studio).

## Setup
1. Node 20+ and pnpm (`corepack enable`).
2. `pnpm install`
3. `cp .env.example .env` and fill `OBS_WS_PASSWORD` (OBS → Tools → WebSocket Server Settings → Enable, Show Connect Info), or enter it later in the dashboard under Settings → OBS.
4. Connect chat: `docs/setup/twitch.md` and `docs/setup/youtube.md` (then Settings → Platforms; the Settings tab or ⌘, opens it).
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

## Alerts and goals
Follows, subs, gift subs, cheers, Super Chats and raids pop up on stream with a sound, and goal bars track followers, subs or tips. They come straight from Twitch and YouTube, with no alert service account. Set them up with [docs/alerts.md](docs/alerts.md).

## Turn the recordings into YouTube videos
streamhub gets the show recorded. [Vanpelt Studio](https://vanpelt.studio) helps with what comes next: it works like an expert YouTube team, finding the videos your audience already wants, then helping you script, shoot, check and package every one (titles and thumbnails included). You edit in whatever editor you like.

## Docs
[`STATUS.md`](STATUS.md) (where every feature stands, what is not verified yet, and how to help), `CLAUDE.md` (rules), `ARCHITECTURE.md`, `EVENTS.md` (event contract), `docs/superpowers/specs/` (design), `docs/go-live.md` (pre-show checklist).

## Contributing
Contributions are welcome, from a test report to a whole module.

**Find something to work on**
- [`STATUS.md`](STATUS.md) lists the gaps in features that already exist, each with a "How to take it further" step.
- [`ROADMAP.md`](ROADMAP.md) lists new features that are not started.
- Testing on real gear helps a lot: most features have only been tested against simulated platforms and devices. Open an issue with your OBS version, platform or device, what worked and what failed.
- For anything bigger than a small fix, open an issue first so we can agree on the approach before you write the code.

**Rules that keep the project in shape** (full list in [`CLAUDE.md`](CLAUDE.md))
- OBS does all video encoding and streaming. streamhub never encodes or sends video.
- The hub binds to 127.0.0.1 only and never accepts internet traffic.
- Platform data is converted into the event types of [`EVENTS.md`](EVENTS.md) before it reaches the bus. A new event goes into `packages/shared` first (type and zod schema), then into `EVENTS.md`.
- Modules talk to the hub only through the event bus, never by importing hub code.
- A connector that fails must not crash the hub: it reports its status and retries.
- Before building a platform connector, read the platform's current official API docs and record what you found in `docs/connectors/<platform>.md`.
- Never commit, log or paste secrets (tokens, stream keys, `.env`, `.streamhub/`), including in issues.

**Before you open a pull request**
1. Run `pnpm test`, `pnpm typecheck` and `pnpm lint`; all three must pass.
2. Add at least one test for your logic, and handle the case where OBS or the platform is disconnected. Tests must run without a real OBS, device or platform account (use mocks or recorded payloads).
3. Update the docs your change affects, and `STATUS.md` if it closes or opens a gap.
4. Keep commits small, with messages like `feat(dashboard): ...`, `fix(hub): ...` or `docs: ...`, and keep reformatting out of lines you did not change.
5. Open the pull request against `main`. Say what changed, why, and how you tested it (including any real hardware or platform).

By contributing, you agree that your contribution is published under the same license as the project (AGPL-3.0, below).

## License
Copyright © 2026 VanpeltVentures Pte Ltd. streamhub is free software under the [GNU Affero General Public License v3.0](LICENSE): you can use, change and share it, but if you distribute a modified version or run one as a service for others, you must publish its source under the same license.
