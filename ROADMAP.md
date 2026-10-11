# ROADMAP.md: what comes after the base

New features that would make streamhub a full studio for streams, podcasts and video, roughly in the order they pay off. Nothing here is built yet.

Gaps in features that already exist (relay and Kick, module settings, the sequencer, hardware acceptance) live in `STATUS.md`. The build order of the base lives in `TASKS.md`. When an item here starts, give it a line in `TASKS.md`; when it ships, move its state to `STATUS.md` and delete it here.

The hard rules in `CLAUDE.md` still apply. In particular, OBS does all the encoding, so every item below either drives OBS or hands its files to another tool.

## 1. Camera follows whoever is talking
A multi-camera podcast needs someone cutting between speakers. The hub already has what that takes: mic levels up to 15 times a second (`audio.levels`) and one scene per camera (`camera.cmd.take`).

- Link each mic to a camera (or a scene) in the Sound tab.
- Cut to the person speaking once they have talked for a moment, hold each shot for a minimum time, and go to a wide shot when people talk over each other or nobody does.
- An on/off switch on the Live tab, and a manual take always wins for a while.
- Testable without hardware: feed simulated levels to the service, as the audio tests do.

**Open questions:** good default timings (start from about 1.5 s of speech to cut and 4 s minimum per shot, then tune on real recordings); whether cuts also go into the recording markers (item 2).

## 2. Recordings that are easy to edit
One take already gives the program recording, a track per mic and a file per camera. The next step is getting from "stop recording" to an edit quickly.

- **Markers:** a Mark button on the Live tab (and optionally a `!clip` chat command from moderators). The hub stores the times with the take and lists them next to the saved files.
- **Chapters:** newer obs-websocket versions can add chapters to Hybrid MP4 recordings. Check the current obs-websocket docs before building on that.
- **Hand-off to editing:** pass the take (files, mic track names, markers, camera cuts) to an editing tool such as Auto-Director, which can transcribe an episode, suggest clips and render them. streamhub writes a small description of the take next to the files and never encodes anything itself.
- **Loudness:** a loudness meter (LUFS) on the stream mix, so the stream and the podcast export need no fixing later.

**Open questions:** the format of the take description (one JSON file per take is the simplest); which loudness target to show by default.

## 3. Remote guests
For a podcast, guests often join from home. VDO.Ninja is the usual way into OBS: each guest is a browser source with its own audio.

- Add a guest from the Sound tab: the hub creates the browser source and the guest becomes a source in the mixer and the headset matrix.
- The hard part is the return audio: each remote guest needs to hear everyone except themselves (a "mix-minus"). That needs design work before building, because the headset mixes play to local devices only.
- Per-guest link, with a copy button that keeps the link off a shared screen.

**Open questions:** how to send each guest their mix-minus; whether VDO.Ninja's own options cover it; the guest's privacy and the terms of the service.

## 4. Show production
Smaller items that make a show look produced. Several are planned as live-coded modules in `TASKS.md`.

- **Name titles:** a lower-third overlay that shows a person's name when their camera is taken, using the mic and camera names the hub already knows.
- **Running order and teleprompter:** the show's segments with timings on the Live tab, and a teleprompter overlay for a second screen.
- **Chat and featured-message overlays:** the dashboard's Feature button already publishes `show.feature.set`; a module needs to show it.
- **Alert extras:** custom sound files and per-alert images (follow-up in `STATUS.md`, Alerts and goals).
