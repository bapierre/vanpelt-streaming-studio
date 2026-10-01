# Multistreaming (Twitch, YouTube, Kick, X)

streamhub never touches video. OBS streams to one platform with its normal output, and the **obs-multi-rtmp** plugin (GPL-2.0, installed separately) streams to the others. With "Sync start/stop with OBS" ticked, the dashboard's Start/Stop button controls every destination.

## 1. OBS
- OBS 30 or newer. Tools → WebSocket Server Settings → **Enable WebSocket server**, set a password, and put it in `.env` as `OBS_WS_PASSWORD`.
- Settings → Stream: your **main** platform (we use Twitch).

## 2. Install obs-multi-rtmp
Download the release for your OS from https://github.com/sorayuki/obs-multi-rtmp/releases and install it. Restart OBS. If it doesn't appear, open Docks → "Multiple output".

## 3. Add one target per extra platform
In the Multiple output dock → **Add new target**, for each:

| Platform | Where to get server + key |
|---|---|
| YouTube | YouTube Studio → Go live → Stream: Stream URL + Stream key |
| Kick | Kick dashboard → Settings → Stream URL & Key |
| X | studio.x.com → Producer → Sources → Create source (RTMP, your region) → URL + key. Then Broadcasts → Create broadcast using that source. |

In each target's settings, tick **Sync start with OBS** and **Sync stop with OBS**.

## 4. Encoder settings that work everywhere
If targets share the main encoder, choose settings every platform accepts. X allows at most 1080p30 at 12 Mbps (9 Mbps recommended). A safe default is **1080p30, ~6000 kbps, keyframe interval 2 s**. With a strong GPU, give targets their own encoder instead.

## Known limit
multi-rtmp has no remote API, so the dashboard only shows the main output's state. Watch the Multiple output dock in OBS for each target's health.
