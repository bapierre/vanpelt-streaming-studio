# Recording a podcast take

One press of **Record** gives you everything an editor needs:

| File | What's in it | Who makes it |
|---|---|---|
| Program recording | The picture the stream shows. Audio track 1 = the stream mix, tracks 2–6 = each mic alone | OBS (track setup: `docs/audio/mics.md`) |
| One file per camera | That camera's full picture, no overlays, same clock as the program | OBS, through the Source Record plugin |
| Camera card (optional) | The camera's own recording, at its best quality | The camera (GoPro), triggered by the hub |

The hub never encodes video. It sets OBS up, follows OBS's recording, and tells you what was saved.

## 1. Install Source Record in OBS

1. Download Source Record from https://obsproject.com/forum/resources/source-record.1285/ (source: https://github.com/exeldro/obs-source-record). Pick the build for your OBS version.
2. Install it, then restart OBS.
3. Check: in OBS, right-click any source → *Filters* → **+**. "Source Record" should be in the list. You don't need to add it yourself.

Without the plugin the program recording still works; the dashboard's **Recording** panel shows "file: plugin missing" for each camera.

## 2. Set the recording folder and format in OBS

*Settings → Output → Recording*: pick the folder, choose **MKV** (or Hybrid MP4) so a crash never loses the take, and pick the hardware encoder (Apple VT on a Mac). Camera files copy these settings.

Each camera file is another encode. A Mac's hardware encoder handles a few 1080p cameras; if OBS shows "Encoding overloaded" with many cameras, lower the camera files' resolution in the filter's settings or switch a camera to card recording.

## 3. Choose how each camera records

In `.streamhub/cameras.json`, each camera may set `record`:

| `record` | Camera file |
|---|---|
| `"obs"` (default) | A file in OBS's recording folder |
| `"card"` | The camera records to its own card (needs a driver that can, e.g. `camera-gopro`) |
| `"both"` | Both |
| `"off"` | No camera file (it still appears in the program recording when it's on air) |

```json
{ "id": "gopro", "name": "GoPro", "driver": "camera-gopro", "scene": "GoPro", "source": "GoPro feed",
  "driverConfig": { "serial": "C3501324567890" }, "record": "both" }
```

Restart the hub after editing the file. When OBS connects, the hub adds a `streamhub ISO` filter to each camera's OBS source. Don't rename it. You can change its encoder settings in OBS; the hub only manages the record mode, folder and file name.

## 4. Record

- **Record** (top bar) starts OBS recording. Camera files and card recordings start with it.
- **Stop recording** needs a second click within 4 seconds, so a stray click never ends the take.
- Starting or stopping from OBS itself, or with an OBS hotkey, works the same way.
- The status bar shows **rec** with the take length, and a warning when the recording folder's disk is low (under 20 GB) or almost full (under 5 GB), with an estimate of minutes left.
- After you stop, **Recording → Saved last take** in the sidebar lists the program file, each camera file, and which cameras recorded to their card.

Camera files are named `<date> <time> <camera id>.<ext>`, so they sort next to the program file.

## Troubleshooting

| Recording panel says | Fix |
|---|---|
| file: plugin missing | Install Source Record (step 1) and restart OBS |
| file: source missing | The camera's `source` in `cameras.json` doesn't match an OBS source name |
| card: not supported | The camera has no driver, or its driver can't record to a card; use `"obs"` |
| card: error / "not recording to its card" | The camera refused. A GoPro may not record to its card while it's a webcam; use `"obs"` for it |
| Camera file missing from "Saved last take" | Check the `streamhub ISO` filter is enabled on that source in OBS |
| No disk line | OBS runs on another computer, so the hub can't see its disk |
