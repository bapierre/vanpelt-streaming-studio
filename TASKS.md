# TASKS.md — build order

The approved design is `docs/superpowers/specs/2026-10-01-streamhub-base-design.md` (§8 has the milestones). Detailed plans live in `docs/superpowers/plans/`.

- [x] M0 Skeleton + M1 Bus, OBS, multistream, dashboard (`plans/2026-10-01-streamhub-m0-m1-foundation.md`); code done, go-live acceptance with real OBS pending
- [x] M2 Direct chat: Twitch + YouTube (`plans/2026-10-01-streamhub-m2-chat.md`); live acceptance pending
- [ ] M3 Relay + Kick
- [ ] M4 Module host + settings

## After the base
- [x] Initial Tauri desktop shell (bundled local hub + existing dashboard, `docs/desktop.md`); keychain storage and signed distribution deferred
- [x] Cameras: per-camera scene switching, OBS-side picture controls, pluggable driver processes, GoPro HERO12 driver (`docs/cameras/`); hardware acceptance pending, desktop builds do not ship drivers yet, no network discovery
- [x] Mics: one OBS track per mic (up to 5) plus the stream mix, per-mic fader/mute/monitoring/sync/voice filters, automatic sound check to a target level, add mics from devices, split two-person stereo devices, dashboard mixer and meters (`docs/audio/mics.md`); hardware acceptance pending, Mono for split devices must be ticked in OBS by hand

Live-coded modules: chat overlay · featured message · transitions · sequencer · teleprompter · roast-o-meter · karaoke picker · hackathon voting · average-ness score · fake-money bets · chat-triggered sounds.
