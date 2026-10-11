# Go-live checklist

Before every show:
1. OBS open; `pnpm start` running; dashboard at http://127.0.0.1:4747 shows **Hub** and **OBS** green.
2. Scenes in the dashboard match OBS; clicking one switches OBS.
3. multi-rtmp dock: every target has Sync start/stop ticked.

First time (and after changing any key), do a private test:
1. Set every platform to private/unlisted/test (YouTube unlisted, X broadcast not public, Twitch/Kick: test channel or short test).
2. Dashboard → Start stream → confirm. Within ~10 s every multi-rtmp target shows green and each platform shows the stream.
3. Dashboard → Stop stream → confirm. Every target stops.

Chat:
1. Dashboard → Settings → Platforms: Twitch and YouTube show **connected**.
2. Status bar: `twitch: live` once connected; `youtube: live` once your broadcast is live (it says `offline` before that).
3. Send a test message from each platform: both appear in the Chat panel within ~2 s, tagged Twitch / YouTube.
4. Delete a Twitch message as moderator: it disappears from the dashboard.
