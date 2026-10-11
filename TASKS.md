# TASKS.md — build order

The approved design is `docs/superpowers/specs/2026-10-01-streamhub-base-design.md` (§8 has the milestones). Detailed plans live in `docs/superpowers/plans/`. `STATUS.md` tracks what each feature still lacks (unverified parts, gaps, how to close them); update it whenever a line here changes.

- [x] M0 Skeleton + M1 Bus, OBS, multistream, dashboard (`plans/2026-10-01-streamhub-m0-m1-foundation.md`); code done, go-live acceptance with real OBS pending
- [x] M2 Direct chat: Twitch + YouTube (`plans/2026-10-01-streamhub-m2-chat.md`); live acceptance pending
- [ ] M3 Relay + Kick
- [ ] M4 Module host + settings: host done (manifests, `/m/<id>/`, per-run token, subscribes/publishes enforced, `modules.list`, desktop packaging); per-module settings UI not started

## After the base
- [x] Initial Tauri desktop shell (bundled local hub + existing dashboard, `docs/desktop.md`); keychain storage and signed distribution deferred
- [x] Cameras: per-camera scene switching, OBS-side picture controls, pluggable driver processes, GoPro HERO12 driver (`docs/cameras/`); hardware acceptance pending, desktop builds do not ship drivers yet, no network discovery
- [x] Multi-camera recording: one take = program recording (mix + isolated mic tracks) + one file per camera via OBS Source Record + optional camera-card recording (GoPro), saved-files list, disk space warnings, confirm-to-stop (`docs/setup/recording.md`); live acceptance pending: Source Record on this OBS version, and whether the GoPro records to its card while in webcam mode
- [x] Mics: one OBS track per mic (up to 5) plus the stream mix, per-mic fader/mute/monitoring/sync/voice filters, automatic sound check to a target level, add mics from devices, split two-person stereo devices, dashboard mixer and meters (`docs/audio/mics.md`); hardware acceptance pending, Mono for split devices must be ticked in OBS by hand
- [x] Dashboard tabs (Live, Sound, Chat, Settings) with Record, Start stream and the status bar on every tab; browser-saved start tab and chat text size
- [x] Headsets: a mix per person through the Audio Monitor plugin, per-source on/off and level, master level and mute, output devices listed on macOS (`docs/audio/headsets.md`); hardware acceptance pending: Audio Monitor on this OBS version and the output delay with several USB adapters
- [x] Alerts and goals, no third-party service: Twitch follows, subs, resubs, gift subs, cheers and raids; YouTube Super Chats, Super Stickers and memberships; one-at-a-time pop-up overlay with synthesized sounds; goal bars for followers, subs or tips per stream or channel total; Settings → Alerts and Goals (`docs/alerts.md`); live acceptance pending with real Twitch and YouTube events. Follow-ups: Ko-fi and other tip pages through the relay, Kick alerts with M3, custom sound files and per-alert images
- [x] Pre-flight: one toolbar checklist before going live (OBS, stream key, platforms, mics, headsets, disk, camera files, cameras, paused alerts), each problem linked to its fix (`docs/go-live.md`)

What comes after: `ROADMAP.md`.

Live-coded modules: chat overlay · featured message · transitions · sequencer · teleprompter · roast-o-meter · karaoke picker · hackathon voting · average-ness score · fake-money bets · chat-triggered sounds.
