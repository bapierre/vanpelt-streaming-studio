# Go-live checklist

Before every show:
1. OBS open; `pnpm start` running; dashboard at http://127.0.0.1:4747 shows **Hub** and **OBS** green.
2. Scenes in the dashboard match OBS; clicking one switches OBS.
3. multi-rtmp dock: every target has Sync start/stop ticked.

First time (and after changing any key), do a private test:
1. Set every platform to private/unlisted/test (YouTube unlisted, X broadcast not public, Twitch/Kick: test channel or short test).
2. Dashboard → Start stream → confirm. Within ~10 s every multi-rtmp target shows green and each platform shows the stream.
3. Dashboard → Stop stream → confirm. Every target stops.

(Chat checks are added here in M2 and M3.)
