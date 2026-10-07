# Desktop app

The Tauri 2 shell contains the existing dashboard. It starts its own local hub, waits for it to be ready, and loads the dashboard from that hub. OBS still handles all video.

## Develop

1. Install Node 20+, pnpm, Rust, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). On macOS, install Xcode command-line tools.
2. Run `pnpm install`.
3. Stop any web hub using the same `HUB_PORT` (default `4747`).
4. Run `pnpm desktop:dev` at the repo root.

The development app uses the repo's `.env` and `.streamhub/secrets.json`, just like `pnpm dev`. It loads a built dashboard rather than Vite: restart `pnpm desktop:dev` after frontend or hub changes. No frontend or hub code is duplicated in the desktop package.

Closing the window stops only the hub started by that desktop instance. The hub also shuts down if its parent pipe closes. Startup has a timeout; an occupied port or invalid configuration produces a native error dialog instead of a blank window.

## Package

Run `pnpm desktop:build`. Output is in `apps/desktop/src-tauri/target/release/bundle/`. On macOS, this produces `macos/streamhub.app`.

For an optional macOS disk image, run `pnpm --filter @streamhub/desktop tauri build --bundles dmg`. Tauri's DMG layout step requires permission to automate Finder; the default `.app` build does not.

Build on the target OS and CPU architecture. The prepare step bundles the current Node executable, the hub JavaScript, the YouTube gRPC protocol definition, and the dashboard. Cross-compilation is not supported by this prepare step. macOS builds are ad-hoc signed for local use; Developer ID signing and notarization for public distribution are not configured.

Packaged apps keep configuration in the OS application-data directory for `com.streamhub.desktop`:

- macOS: `~/Library/Application Support/com.streamhub.desktop/`
- Windows: `%APPDATA%\com.streamhub.desktop\`
- Linux: `$XDG_DATA_HOME/com.streamhub.desktop/` (usually `~/.local/share/com.streamhub.desktop/`)

Put `.env` in that directory, using `.env.example` as the template for OBS and Twitch configuration. Platform tokens and the YouTube client credentials are stored in `.streamhub/secrets.json` within the same directory, still owner-only and atomically written. A packaged app does not automatically copy the repo's credentials. OS keychain migration and an in-app OBS configuration editor are deferred.

## Boundaries

- All hub listeners remain on `127.0.0.1`. The web app's existing WebSocket origin rules apply unchanged.
- The native shell exposes no JavaScript commands or shell permissions to the dashboard.
- HTTPS links, including OAuth sign-in, open in the system browser. Other external navigation is blocked.
- `STREAMHUB_DATA_DIR`, `STREAMHUB_DASHBOARD_DIR`, `STREAMHUB_PROTO_PATH`, and `STREAMHUB_DESKTOP` are internal environment variables supplied by the shell, not `.env` settings.

## Checks

- `pnpm test`, `pnpm typecheck`, `pnpm lint`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`

Desktop integration tests build the hub in a temporary directory without `node_modules`, then check dashboard serving, same-origin WebSocket access, occupied-port behavior, parent-pipe shutdown, and packaged gRPC loading. Prepare resources with `pnpm desktop:prepare` before running the Rust checks.
