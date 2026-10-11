# Writing a camera driver

A camera driver is a module that lets the hub control one camera model: start and stop its webcam mode, change its settings, read its battery. Video never goes through the driver; OBS captures the camera as usual.

Every camera gets OBS-side controls (brightness, contrast, saturation, gamma, mirror, crop) without a driver. Write a driver only when the camera itself can be controlled.

## 1. Make the module folder

```
modules/camera-<model>/
  manifest.json
  package.json
  src/main.ts
```

`manifest.json`:
```json
{
  "id": "camera-<model>",
  "name": "Brand Model (how it connects)",
  "version": "0.1.0",
  "driver": { "entry": "src/main.ts" }
}
```
- `id` must equal the folder name.
- `driver.entry` is relative to the folder and must stay inside it. In `pnpm dev` the hub runs `.ts` entries through tsx; packaged desktop builds can only run `.js` entries.

`package.json` depends on `@streamhub/camera-sdk` (`"workspace:*"`). Run `pnpm install` once after adding the folder.

## 2. Implement a device

```ts
import { runDriver, type CameraDevice } from '@streamhub/camera-sdk';

runDriver((camera, report) => {
  // camera.config is this camera's "driverConfig" from .streamhub/cameras.json
  const device: CameraDevice = {
    start() {
      report({ status: 'connecting', controls: [] });
      // connect, then report again; retry on your own with backoff
    },
    async stop() {
      // clear timers; do not switch the camera off, the show may still be running
    },
    async set(key, value) {
      // apply the control, then report the new state
    },
  };
  return device;
});
```

Rules:
- **Report, don't return.** Call `report()` whenever anything changes. The hub keeps the latest report and the dashboard redraws from it.
- **Fail soft.** `start()` must not throw. When the camera is unplugged, report `disconnected` with a `detail` the streamer can act on ("GoPro not reachable at 172.27.189.51: is USB plugged in?") and keep retrying.
- **Describe controls.** Each control is a `select`, `range`, `toggle` or `action` (see `CameraControl` in EVENTS.md). Set `disabled` with a reason when a control can't be used right now. Keys may not start with `obs.`.
- **Offer an OBS recipe** when the camera can be captured without extra software: `obsInput: { kind, settings }`. The dashboard then shows a "Create OBS scene" button.
- **Card recording (optional).** If the camera can record to its own card, implement `async record(on)` and include `card: { supported: true, recording, detail? }` in every report. The hub calls `record(true)` when OBS starts recording and `record(false)` when it stops, for cameras configured with `"record": "card"` or `"both"`. Report `recording` from what the camera says it is doing, not from what you asked for, and put the reason in `detail` when it refuses.
- **Never log secrets.** Driver stdout and stderr go to the hub log, prefixed with `[driver:<id>]`.

## 3. Configure a camera that uses it

`.streamhub/cameras.json` (in the data directory, next to `secrets.json`):
```json
[
  {
    "id": "gopro",
    "name": "GoPro HERO12",
    "driver": "camera-gopro",
    "scene": "GoPro",
    "source": "GoPro feed",
    "driverConfig": { "serial": "C3501324567890" }
  }
]
```
Restart the hub after editing the file.

## How it runs

- The hub starts one process per driver for all cameras that use it, with only `PATH`, `HOME`, temp and locale variables plus `STREAMHUB_*` launch details. Drivers never see the hub's `.env`.
- The driver connects to `ws://127.0.0.1:<port>/ws?driver=<id>&token=<token>`. The token changes on every launch. The connection may publish only `camera.driver.state` for its own cameras and receives only `camera.driver.cmd.set` for them.
- If the process exits, its cameras show `error` and the hub restarts it with backoff. When the hub stops, it sends SIGTERM; when the hub dies, the driver's stdin closes and `runDriver` exits.

## Test it

Make the camera's HTTP or SDK calls injectable and test the device against a fake, as `modules/camera-gopro/src/gopro.test.ts` does. Cover at least: the camera being unreachable, a control being rejected, and the connection being lost mid-show.
