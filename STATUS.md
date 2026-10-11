# STATUS.md: where every feature stands

This is the one place that tracks how far each feature got, what has not been checked, and what is missing. Each section ends with how to take it further, so anyone can pick up a gap, whether in their own copy or as a contribution here.

`TASKS.md` keeps the build order. The design is in `docs/superpowers/specs/2026-10-01-streamhub-base-design.md`. When you close a gap, update the section here in the same change.

## Words used here
- **Built:** code, tests and docs are in the repo, and it runs with `pnpm dev`.
- **Simulated only:** tested against mocks, fixtures or a local stand-in for the platform, never against the real thing.
- **Acceptance pending:** nobody has yet run it end to end with the real platform, OBS plugin or device. Bugs are most likely here.
- **Not built:** designed (or only mentioned), no code yet.

## Summary

| Area | State | Biggest open item |
| :- | :- | :- |
| [Bus, OBS bridge, dashboard](#bus-obs-bridge-and-dashboard) | Built, acceptance pending | First real go-live with OBS (`docs/go-live.md`) |
| [Multistreaming](#multistreaming) | Built (OBS plugin does the work) | Per-target health is invisible to the hub |
| [Twitch chat](#twitch-chat) | Built, acceptance pending | Live test; Developer Services Agreement not read |
| [YouTube chat](#youtube-chat) | Built, acceptance pending | 7-day sign-in expiry, `streamList` quota cost |
| [X](#x) | Live status only | No chat (Enterprise API, pricing unknown) |
| [Relay and Kick (M3)](#relay-and-kick-m3) | Not built | Everything; `apps/relay` does not exist yet |
| [Module host (M4)](#module-host-m4) | Host built, settings not built | Per-module on/off and settings in the dashboard |
| [Alerts and goals](#alerts-and-goals) | Built, acceptance pending | Real Twitch and YouTube events |
| [Cameras](#cameras) | Built, acceptance pending | GoPro HERO12 on real hardware |
| [Recording](#recording) | Built, acceptance pending | Source Record on a real OBS, GoPro card in webcam mode |
| [Mics](#mics) | Built, acceptance pending | Real mics and interfaces |
| [Headsets](#headsets) | Built, acceptance pending | Audio Monitor on a real OBS, delay with several USB adapters |
| [Desktop app](#desktop-app) | Built for local use | Signing, notarization, keychain, camera drivers |
| [Transitions and sequencer](#transitions-and-sequencer) | Not built | Designed in `ARCHITECTURE.md` §4 and §5 |
| [Live-coded modules](#live-coded-modules) | Not built (except alerts) | Listed in `TASKS.md` |
| [Security, legal and ToS](#security-legal-and-tos) | Partly done | Required before the relay holds anyone else's tokens |

---

## Bus, OBS bridge and dashboard
Milestones M0 and M1. Code: `apps/hub/src/{bus,ws,obs}`, `apps/dashboard`, `packages/overlay-sdk`.

**Works:** one event bus mirrored over WebSocket on 127.0.0.1, topic subscriptions with retained state, chat history ring buffer, OBS scenes, sources, start and stop stream, status bar, and the Live, Sound, Chat and Settings tabs.

**Not verified:** the M1 done criterion, "one click goes live on all configured platforms", has not been run with a real OBS. All OBS tests use a mocked `obs-websocket-js`.

**How to take it further:** run `docs/go-live.md` with private test streams on every platform. Record the OBS version and anything that failed in this section.

## Multistreaming
OBS sends the video to every platform through the obs-multi-rtmp plugin. Setup: `docs/multistream.md`.

**Works:** the hub's start and stop drive every target when "Sync start/stop with OBS" is on.

**Missing:** multi-rtmp has no remote API, so the hub only sees the main output. Each target's health shows only in OBS's Multiple output dock.

**How to take it further:** propose a remote API (an obs-websocket vendor request is the natural fit) to the multi-rtmp project upstream. Once it exists, the OBS bridge can publish per-target state and the status bar can show it.

## Twitch chat
Milestone M2. Code: `apps/hub/src/connectors/twitch`. Findings: `docs/connectors/twitch.md`. Setup: `docs/setup/twitch.md`.

**Works (simulated only):** EventSub over WebSocket, Device Code Flow with a public client, refresh on 401, hourly validation, deletions and clears, unified chat.

**Not verified:**
- A live chat with a real channel (M2 done criterion: Twitch and YouTube merge within about 2 s, and one failing does not affect the other).
- The Developer Services Agreement's data-retention terms; legal.twitch.com could not be read by the tools used.
- The open questions in `docs/connectors/twitch.md` §7 (refresh-token expiry rule, `founder` and `lead_moderator` badges, gif fragment id field, and more).

**How to take it further:** connect a real channel, send messages, delete one, clear a user, and compare with §7. Read the agreement in a browser and add what it says about keeping chat to §6 of the findings.

## YouTube chat
Milestone M2. Code: `apps/hub/src/connectors/youtube`. Findings: `docs/connectors/youtube.md`. Setup: `docs/setup/youtube.md`.

**Works (simulated only):** `liveChatMessages.streamList` over gRPC with polling fallback, broadcast lookup, loopback OAuth with PKCE, bring-your-own Google project.

**Known limits:**
- YouTube's policy forbids shipping API credentials in open-source apps, so every streamer creates a Google project (about 5 minutes).
- In "Testing" mode Google expires the sign-in after 7 days.
- YouTube stopped reporting deleted messages on 2026-06-23, so removal is best effort.

**Not verified:** the open questions in `docs/connectors/youtube.md` (Open questions), mainly: whether an unverified "In production" app avoids the 7-day expiry, whether `streamList` is billed per connection or per response, and whether `liveChatMessages.list` costs 1 or 5 units.

**How to take it further:**
- Measure quota: watch the Google Cloud quota page during a one-hour live chat on `streamList`, then on polling.
- Set a project to "In production" and check whether sign-in survives day 8.
- Longer term, the design's "connect with one click" needs a project that passes Google verification and the YouTube API compliance audit. The connector already takes a `TokenSource`, so only the token source changes.

## X
Code: `apps/hub/src/connectors/x`. Findings: `docs/connectors/x.md`. Setup: `docs/setup/x.md`.

**Works (simulated only):** video goes to X through OBS (RTMP key from Media Studio Producer). With the streamer's own X app, the hub shows broadcast state and viewer count (`platform.live`).

**Known limits:**
- X limits the whole Livestream API to approved apps; without approval `GET /2/broadcasts` returns 403.
- Ingest state needs an allowlist-only endpoint, so it usually shows `unknown`.
- Owned reads cost $0.001 per resource.

**Missing:** X chat. It is delivered only as `broadcast.chat` webhooks (so it would need the relay), and its price is not published; similar events suggest roughly $120 to $700 a month per streamer.

**How to take it further:** apply for Livestream API access and ask X for `broadcast.chat` pricing. If it is affordable, add X as a relay platform (bring your own X app on a self-hosted relay is the cheapest first step).

## Relay and Kick (M3)
Not built. Design: spec §4.3 and §4.4. `apps/relay` does not exist yet, and there is no `docs/connectors/kick.md`.

**Planned:** a Cloudflare Worker (the only internet-facing part) that runs Kick OAuth, receives signed Kick webhooks, and forwards raw payloads to the streamer's hub over one WebSocket; normalization stays in the hub. Encrypted tokens in D1, rate limits, kill switch, privacy and terms pages, self-hosting with only `RELAY_URL` changed. An opt-in, clearly unofficial `kick-pusher` connector covers the case where the relay is unavailable.

**Done when:** Kick chat appears in the feed through the hosted relay, and a self-hosted relay works with only `RELAY_URL` changed.

**How to take it further:**
1. Do the Kick spike first, per "Verify before building" in `ARCHITECTURE.md`: read Kick's current official docs for OAuth, scopes, `chat.message.sent`, the webhook signature scheme, rate limits and terms. Write `docs/connectors/kick.md`.
2. Add the hub and relay protocol to `packages/shared` (spec §5), then the Worker, then a `relay` connector in the hub.
3. With the relay in place, Kick alerts and tip pages such as Ko-fi can follow (see Alerts and goals).

## Module host (M4)
Code: `apps/hub/src/modules`, `packages/shared/src/modules.ts`. Contract: `EVENTS.md` (Modules), `ARCHITECTURE.md` §7.

**Works:** manifests in `modules/*`, pages served at `/m/<id>/`, a per-run token per module, subscribe and publish permissions enforced by the hub, `modules.list`, and desktop packaging of overlay modules. Alerts is the first module.

**Missing:** the Settings part of M4. There is no way in the dashboard to turn a module on or off or change its settings. The M4 done criterion ("a hello-world module dropped into `modules/` loads as a Browser Source and can be toggled off") is half met.

**How to take it further:** add an enabled flag per module stored by the hub (with a retained event and a command in `packages/shared`), refuse `/m/<id>/` and the module's bus role while it is off, and add a Settings → Modules page listing `modules.list`. Ship a tiny hello-world module as the test.

## Alerts and goals
Code: `apps/hub/src/alerts`, `modules/alerts`, `apps/dashboard/src/components/{AlertsPanel,GoalsPanel}.tsx`. Docs: `docs/alerts.md` (user guide), `docs/connectors/alerts.md` (sources and mapping).

**Works (simulated only):** Twitch follows, subs, resubs, gift subs, cheers and raids; YouTube Super Chats, Super Stickers and memberships; a one-at-a-time pop-up with synthesized sounds; goal bars for followers, subs or tips, per stream or channel total; Settings → Alerts and Goals. An end-to-end run against a local EventSub simulator and a scripted YouTube stream passed, but no real platform event has gone through it.

**Known limits:**
- Twitch accounts connected before alerts existed must reconnect to grant the new scopes.
- YouTube sends no live new-subscriber event, rounds subscriber totals to three significant figures, and has no API for member counts.
- Twitch has no tips, so tips goals count YouTube only.

**Not verified:** whether Twitch reports Prime on `resub` as well as `sub`, and how YouTube formats Super Chats in currencies without minor units such as JPY (`docs/connectors/alerts.md` §4).

**Missing:** Ko-fi and other tip pages (need the relay), Kick alerts (with M3), custom sound files and per-alert images.

**How to take it further:** go live on a test channel and trigger each alert kind (a friend's follow, a test cheer, a Super Chat), then check the pop-up and goals. For custom sounds and images, files would be served by the alerts module with paths saved in its settings, which fits naturally after the M4 settings work.

## Cameras
Code: `apps/hub/src/cameras`, `packages/camera-sdk`, `modules/camera-gopro`. Docs: `docs/cameras/`.

**Works (simulated only):** a scene per camera, OBS-side picture controls, pluggable driver processes, and a GoPro HERO12 driver over USB.

**Not verified** (`docs/cameras/gopro.md`, Verify on real hardware): anti-flicker and HyperSmooth option values on HERO12, whether zoom works in webcam mode, stream latency, and whether the camera records to its card while in webcam mode.

**Missing:** discovery over mDNS (set `serial` or `host` by hand), Wi-Fi and COHN connections, and camera drivers in the desktop app (it ships overlay modules only). The Sony A6400 works only as a plain OBS source because Sony has no public SDK for it (`docs/cameras/sony-a6400.md`).

**How to take it further:** test with a HERO12 and record the results in `docs/cameras/gopro.md`. New cameras: follow `docs/cameras/writing-a-driver.md`. Shipping drivers in the desktop app means bundling each driver's runtime in `apps/desktop/scripts/prepare.mjs`.

## Recording
Code: `apps/hub/src/recording`. Setup: `docs/setup/recording.md`.

**Works (simulated only):** one Record press gives the program recording (stream mix plus one track per mic), one file per camera through the Source Record plugin, and optionally the GoPro's own card; saved-files list, disk space warnings, confirm-to-stop.

**Not verified:** the Source Record plugin on the current OBS version, and GoPro card recording in webcam mode (see Cameras).

**Missing:** pause and resume.

**How to take it further:** record a 10-minute take with every camera and mic, then check that the files line up on one timeline in an editor.

## Mics
Code: `apps/hub/src/audio`. Docs: `docs/audio/mics.md`.

**Works (simulated only):** one OBS track per mic plus the stream mix, faders, mute, monitoring, sync offset, voice filters, automatic sound check, adding mics from devices, splitting two-person stereo devices, dashboard mixer and meters.

**Known limits:** at most 5 isolated mic tracks (OBS has 6 tracks and track 1 is the mix). For split devices, Mono must be ticked in OBS by hand because OBS does not let streamhub change that setting.

**How to take it further:** run the sound check with real mics and an interface and check the levels it lands on. If a future obs-websocket exposes the mono setting, the hub can set it.

## Headsets
Code: `apps/hub/src/headsets`. Docs: `docs/audio/headsets.md`.

**Works (simulated only):** a mix per person through Exeldro's Audio Monitor plugin, per-source on/off and level, master level and mute.

**Not verified:** the Audio Monitor plugin on the current OBS version, and the output delay with several USB adapters.

**Missing:** output devices are listed on macOS only; on other systems the device name must be typed exactly as the system shows it.

**How to take it further:** test with two or three USB adapters and note the delay. For Windows and Linux, add device listing next to the macOS one in `apps/hub/src/headsets/outputs.ts`.

## Desktop app
Code: `apps/desktop`. Docs: `docs/desktop.md`.

**Works:** a Tauri 2 shell that bundles Node, the hub, the dashboard and the overlay modules; no Node install needed. The packaged hub passed a smoke test.

**Known limits:**
- macOS builds are ad-hoc signed: fine on the build machine, blocked by Gatekeeper elsewhere, and folder-access prompts return after every rebuild.
- The app must run from `~/Applications` or `/Applications`, not from a protected folder such as `~/Documents`.
- Build on the target system and CPU; no cross-compiling.

**Missing:** Developer ID signing and notarization, tested Windows and Linux packages (only macOS has been packaged so far), secrets in the OS keychain (they stay in `.streamhub/secrets.json`), and camera drivers.

**How to take it further:** add signing and notarization to `pnpm desktop:build` with an Apple Developer ID (credentials from CI, never in the repo). Keychain: give `SecretsStore` (`apps/hub/src/secrets/store.ts`) a keychain-backed version for the desktop app, keeping the file for `pnpm dev`.

## Transitions and sequencer
Not built. Design: `ARCHITECTURE.md` §4 (overlay transitions timed by the hub) and §5 (cue lists from `config/sequences/*.json`). Their events (`show.transition.*`, `show.sequence.*`) are not in `packages/shared` yet (`EVENTS.md`).

**How to take it further:** add the events to `packages/shared` first, then the sequencer as a module (the spec moved both out of the base), then a dashboard section with a button per sequence, running state and cancel.

## Live-coded modules
Planned in `TASKS.md`: chat overlay, featured message, transitions, sequencer, teleprompter, roast-o-meter, karaoke picker, hackathon voting, average-ness score, fake-money bets, chat-triggered sounds. Only alerts exists. `show.feature.set` is already published by the dashboard's Feature button, waiting for a featured-message module.

**How to take it further:** copy `modules/alerts` for the layout (manifest, `web/`, Vite build), ask only for the events it needs in the manifest, and talk to the hub only through `packages/overlay-sdk`.

## Security, legal and ToS
Spec §9 lists the open risks.

**Done:** the hub binds to 127.0.0.1 only; secrets live in `.env` and an owner-only `.streamhub/secrets.json` written atomically; secrets are never logged or published; modules get a per-run token and only the events their manifest allows.

**Required before the relay holds anyone else's tokens:** encryption at rest, revocation on disconnect, a privacy policy and terms page, rate limits and a kill switch (spec §4.3).

**Not verified:** Kick webhook reliability (the Pusher fallback is the plan), the Twitch Developer Services Agreement, and the terms of every new platform before its connector is built.

**How to take it further:** review the relay design before M3 starts, and run a security review of the hub's HTTP and WebSocket surface (origin checks, module tokens, OAuth callbacks).
