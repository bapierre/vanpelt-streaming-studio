# Sony A6400 (OBS-only camera)

The A6400 runs without a driver. Video comes in through Sony's **Imaging Edge Webcam** app, and streamhub controls the picture on the OBS side: brightness, contrast, saturation, gamma, mirror and crop. Camera settings such as ISO, white balance or focus are not available.

## Why there is no driver

Checked on 2026-10-07:
- Sony's public **Camera Remote SDK** does not list the ILCE-6400 (https://support.d-imaging.sony.co.jp/app/sdk/en/index.html).
- The ILCE-6400 is only covered by **Camera Remote Command**, a PTP protocol that Sony gives to corporate customers only (https://support.d-imaging.sony.co.jp/app/cameraremotecommand/en/index.html). It can't ship in an open-source project.
- Imaging Edge Webcam holds the camera's USB connection while it streams, so a second program could not control the camera anyway.

## Setup

1. Install Imaging Edge Webcam from Sony and update the camera firmware.
2. On the camera: *Menu → Network/USB → USB Connection → PC Remote*. Connect it over USB. Use a dummy battery or a USB power source for long shows.
3. In OBS, create a scene (for example `Sony`) and add a **Video Capture Device** source named `Sony A6400`, choosing "Imaging Edge Webcam" as the device.
4. Add the camera to `.streamhub/cameras.json`:
   ```json
   { "id": "sony", "name": "Sony A6400", "scene": "Sony", "source": "Sony A6400" }
   ```
5. Restart the hub. The camera card shows **ready** when OBS has the scene and source.

## Notes

- Picture adjustments live in a Color Correction filter named `streamhub color` on the source. Edit it in OBS too if you like; the dashboard shows the new values after the next OBS scene-list change or hub restart.
- **Mirror** flips the source in the scene like OBS's "Flip Horizontal". Check the result once if the source uses bounding boxes.
- If the A6400 overheats, set *Auto Power OFF Temp.* to *High* on the camera; streamhub can't read the camera's temperature.
