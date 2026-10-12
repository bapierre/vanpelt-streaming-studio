# Bundle the Audio Monitor plugin with the desktop app

Date: 2026-10-12
Status: done

## Why

Headset mixes need Exeldro's Audio Monitor plugin inside OBS. Today the dashboard links to the
OBS forum and the user installs it by hand. That is the last manual setup step; the desktop app
should ship the plugin and drop it into OBS's user plugin folder on first run.

## Facts (verified 2026-10-12)

- Latest release: **0.10.1**. Assets: macOS `pkg` (sha256 `5d868be6…4f05`), Windows `zip`
  (sha256 `99a04195…b588`), Linux `deb`.
- macOS pkg payload: `Library/Application Support/obs-studio/plugins/audio-monitor.plugin`
  (universal binary, adhoc-signed — fine, OBS disables library validation). Extract with
  `pkgutil --expand-full` (no root). Skip the `.dSYM`.
- Windows zip: `obs-plugins/64bit/audio-monitor.dll` + `data/obs-plugins/audio-monitor/locale/*`;
  user-level install layout is `plugins/audio-monitor/bin/64bit/` + `plugins/audio-monitor/data/`.
- License: **GPLv2**. Bundling an unmodified binary is mere aggregation (§2): allowed. We ship the
  LICENSE and a NOTICE with attribution + source link, never modify the binary.
- OBS user plugin dirs: macOS `~/Library/Application Support/obs-studio/plugins`,
  Windows `%APPDATA%\obs-studio\plugins`, Linux `~/.config/obs-studio/plugins`.

## Plan

1. `apps/desktop/scripts/fetch-audio-monitor.mjs` — downloads the pinned assets, verifies sha256,
   extracts to `apps/desktop/resources/audio-monitor/{macos,windows}/`, writes LICENSE + NOTICE.
   Runs from `prepare.mjs`. Resources are already bundled wholesale by tauri.conf and gitignored.
2. `apps/hub/src/headsets/plugin.ts` — `installAudioMonitor({ resourceDir, configDir, log })`:
   - no resourceDir (CLI hub) → `no-resource`, no-op;
   - plugin present but not ours (no marker) → `user-install`, never touch;
   - marker version matches → `current`;
   - otherwise copy and write marker `plugins/.streamhub-audio-monitor.json` → `installed`;
   - OBS config dir missing (OBS never ran) → `absent` with a log line.
3. `main.ts` runs the installer with `STREAMHUB_AUDIO_MONITOR_DIR` (set by the desktop shell) and
   hands `pluginInstalled` to `HeadsetService`. Snapshot gains `pluginPending: boolean`
   (= installed on disk but OBS has not loaded it), so the dashboard can say "restart OBS"
   instead of "go download a plugin". Linux gets no bundled plugin for now: docs keep the manual step.
4. Desktop `main.rs`: pass `STREAMHUB_AUDIO_MONITOR_DIR` for the current platform.
5. Dashboard: notice branches on `pluginPending`.
6. Docs: EVENTS.md, docs/audio/headsets.md (install section becomes automatic), ARCHITECTURE.md,
   docs/desktop.md, STATUS.md.

## Not doing

- Linux bundling (deb extraction, several distros): manual install stays.
- Auto-restarting OBS (must never kill someone's stream; the user restarts).
- Upgrading a foreign (marker-less) install: respected, never overwritten.
