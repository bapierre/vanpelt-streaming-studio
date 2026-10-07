# GoPro (camera-gopro)

Controls a GoPro over USB with the official Open GoPro HTTP API and lets OBS receive the webcam stream directly. It **replaces the GoPro Webcam desktop app**: quit that app first, because both talk to the same camera API.

Checked against the Open GoPro HTTP API 2.0 docs (https://gopro.github.io/OpenGoPro/http) on 2026-10-07. Built for a HERO12 Black; HERO9–HERO13 expose the same webcam endpoints, but HERO9/10/11 ignore the `port` and `protocol` options.

## Setup

1. Update the camera firmware. Connect it to the computer with a USB-C data cable and switch it on. macOS needs no driver (the camera shows up as a USB network device).
2. Find the serial number: *Preferences → About → Camera Info*, or the sticker in the battery door.
3. Add the camera to `.streamhub/cameras.json`:
   ```json
   {
     "id": "gopro",
     "name": "GoPro HERO12",
     "driver": "camera-gopro",
     "scene": "GoPro",
     "source": "GoPro feed",
     "driverConfig": { "serial": "C3501324567890" }
   }
   ```
   Optional `driverConfig` keys: `host` (overrides the address derived from the serial; may include `:port`), `port` (UDP port for the stream, default 8554; give each GoPro its own), `resolution` (`"1080p"` or `"720p"`), `lens` (`"wide"`, `"narrow"`, `"superview"`, `"linear"`).
4. Restart the hub. Once the camera shows **ready**, press **Create OBS scene** on its card. That adds the `GoPro` scene with a Media Source reading `udp://@:8554` (MPEG-TS, 1 MB buffer, hardware decoding).
5. Switch **Webcam stream** on.

## What it does

| | Endpoint | Notes |
|---|---|---|
| Address | `172.2X.1YZ.51:8080` | XYZ = last three digits of the serial |
| On connect | `GET /gopro/camera/control/wired_usb?p=0` | Docs: wired USB control must be off before webcam commands |
| Keep-alive | `GET /gopro/camera/keep_alive` every 3 s | Docs' recommended interval; two misses in a row = disconnected |
| Status | `GET /gopro/camera/state` every 5 s | status 70 = battery %, status 6 = system hot; settings 134/135 |
| Webcam | `GET /gopro/webcam/status`, `start?res=&fov=&port=&protocol=TS`, `stop`, `exit` | Stream is H.264 in MPEG-TS over UDP |
| Settings | `GET /gopro/camera/setting?setting=<id>&option=<n>` | 403 lists the accepted options; the driver adopts that list |
| Zoom | `GET /gopro/camera/digital_zoom?percent=<0–100>` | |

Controls on the dashboard: webcam on/off, resolution (1080p/720p), lens (wide, narrow, SuperView, linear), HyperSmooth, anti-flicker, digital zoom. Changing resolution or lens restarts the stream. HyperSmooth can only change while webcam mode is exited, so the driver stops, exits, applies and restarts.

When the hub stops, the webcam keeps streaming, so restarting the hub does not black out the show.

## Verify on real hardware

These could not be checked without a camera:
- Option values for anti-flicker and HyperSmooth on HERO12. The current docs only list HERO13 values. The driver starts with HERO12 values (60 Hz = 2, 50 Hz = 3; HyperSmooth off = 0, low = 1, auto boost = 4) and switches to the camera's own list after the first rejection.
- Whether digital zoom applies in webcam mode.
- Stream latency of the Media Source; lower `buffering_mb` in OBS if it lags.

## Not yet

- Discovery over mDNS (`_gopro-web`): set `serial` or `host` instead.
- Wi-Fi / COHN connections.
