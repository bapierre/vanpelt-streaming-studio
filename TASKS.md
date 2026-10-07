# TASKS.md — build order

The approved design is `docs/superpowers/specs/2026-10-01-streamhub-base-design.md` (§8 has the milestones). Detailed plans live in `docs/superpowers/plans/`.

- [x] M0 Skeleton + M1 Bus, OBS, multistream, dashboard (`plans/2026-10-01-streamhub-m0-m1-foundation.md`); code done, go-live acceptance with real OBS pending
- [x] M2 Direct chat: Twitch + YouTube (`plans/2026-10-01-streamhub-m2-chat.md`); live acceptance pending
- [ ] M3 Relay + Kick
- [ ] M4 Module host + settings

## After the base
- [x] Initial Tauri desktop shell (bundled local hub + existing dashboard, `docs/desktop.md`); keychain storage and signed distribution deferred

Live-coded modules: chat overlay · featured message · transitions · sequencer · teleprompter · roast-o-meter · karaoke picker · hackathon voting · average-ness score · fake-money bets · chat-triggered sounds.
