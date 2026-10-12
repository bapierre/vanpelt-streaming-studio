# Audio patch bay: camera sources, source identity, source→output routing

Date: 2026-10-12. Status: approved by owner (four design decisions confirmed in chat).

## Why

The show needs chaotic/improvised audio setups: a shotgun mic plugged into a camera
body should be mixable like any other mic, every source should be identifiable and
renamable, and any source should be wireable to any output on demand — the stream
itself being one of the outputs. Checking "what does the stream hear" on AirPods or
"what does my friend's headset hear" should be a tap, not a rewiring session.

## Decisions (confirmed)

1. **Model:** headsets generalize into a patch bay. Outputs = any audio device
   (headsets, AirPods, speakers). "Stream" becomes a special first column. One matrix
   wires sources → outputs. The `headsets.*` event names and `headsets.json` stay
   (migration-free); the UI calls it Routing.
2. **Tap-in:** an output can *live-mirror* another node (`mirror: 'stream' | <outputId>`),
   so rewiring the stream automatically rewires the AirPods following it.
3. **Stream wiring = OBS track-1 membership.** Unwired sources keep recording to their
   isolated track; nothing is lost.
4. **Off-screen camera audio:** OBS only produces a source's audio while it is active.
   The hub shows a "silent while off-screen" badge on camera sources and never forces
   sources to stay active (battery/heat cost on real cameras).

## Contract (`packages/shared`)

`headsets.ts`:
- `HeadsetSource`: `kind` gains `'camera'`; new `detail` (origin label: camera name or
  OBS input name) and `live` (OBS is producing audio for it now).
- `HeadsetsState` gains `stream: Record<SourceKey, { on, db? }>` and
  `labels: Record<SourceKey, string>` (display-name overrides for any source).
- `HeadsetState`/`HeadsetPatch` gain `mirror: 'stream' | HeadsetId | null`.
- New commands: `headsets.cmd.setStream { source, on?, db? }` (non-mic sources; `db` maps
  to the OBS input fader) and `headsets.cmd.renameSource { source, name }` (labels any
  source; never touches recording track names).

`audio.ts`:
- `MicPatch` gains `stream?: boolean`; `MicState` gains `onStream: boolean`.

## Hub

**audio** (`apps/hub/src/audio`): `MicConfig.stream` (default true); `tracksFor` includes
track 1 only when the mic is wired to the stream; `audio.cmd.set` accepts `stream`;
`MicState.onStream` comes from config (the hub owns mic tracks already).

**headsets** (`apps/hub/src/headsets`):
- Options gain the static camera list (`name` + OBS `source`) so camera inputs get
  `kind: 'camera'` and the camera name as `detail`.
- `InputActiveStateChanged` tracked per input → `live` per source (default true; best
  effort initial read, wrapped for older obs-websocket).
- Stream column for non-mic sources: read-modify-write track 1 via
  `GetInputAudioTracks`/`SetInputAudioTracks` (other tracks preserved), persisted in
  config `streamSends`; `db` → `SetInputVolume`. Mic rows defer to `audio.cmd.set`.
- Mirror: effective sends of an output with `mirror` are the mirrored node's (stream
  column or another output). Cycles rejected. State publishes `mirror` and the effective
  sends; `setSend` on a mirrored output is refused (log + no-op).
- New *camera* sources join existing outputs **off** (mics and OBS inputs keep the
  current join-on default).

## Dashboard

`HeadsetMatrix` becomes the Routing matrix in the Sound tab:
- First column "Stream": on/off per source (dB slider for non-mic sources).
- Row headers: display name with inline rename, kind badge, origin detail, and a
  "silent while off-screen" badge when a camera source is not live.
- Output headers gain a "follows" selector (none / Stream / any other output); a
  mirrored output's cells render its effective mix, read-only.
- Add-output form stays (name, device, optional owner).

## Docs

EVENTS.md (headsets section), `docs/audio/headsets.md` (routing/monitoring concepts),
ARCHITECTURE.md note, STATUS.md (Headsets section).

## Commits

1. `feat(shared)`: patch-bay contract.
2. `feat(hub)`: per-mic stream track toggle.
3. `feat(hub)`: headsets become a source→output patch bay.
4. `feat(dashboard)`: routing matrix in the Sound tab.
5. `docs`: routing/patch bay.

## Acceptance

With OBS running: plug or fake a camera with audio, see it appear as
`kind: camera` with the camera's name; wire it to the stream and to an output; mirror
the stream to a second output and confirm it follows rewiring; switch scenes and see
the off-screen badge come and go.
