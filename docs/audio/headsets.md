# Headsets and routing: a mix for each output

The Sound tab is a patch bay: every sound source — the mics, the audio of each camera (such as a shotgun mic on the camera body), and any other OBS audio — wired to every output: the stream mix first, then one headset per person. The host might want the guest louder and the music quieter, while the guest wants less of their own voice. streamhub sets this up in OBS. The audio never goes through the hub.

## How it works

Each headset is one output device on this computer, such as a USB headphone adapter or one output of an audio interface. For every source a headset should hear, the hub adds a filter called `streamhub hp <headset>` to that source in OBS. The filter comes from Exeldro's **Audio Monitor** plugin, which plays the source to any output device at its own level.

- The filter sits last on the source, after the mic filters (gain, noise suppression, EQ and the rest). Headsets hear the cleaned-up voice.
- Headset levels are separate from the stream. Moving a fader in the mixer never changes what a headset hears, and the reverse is also true.
- A muted mic is silent in every headset too.
- The plugin can only turn a sound down, so headset levels go up to 0 dB. To make a whole headset louder, turn up its master level, or turn up the volume on the headphones or adapter.

The **Stream** column is what the audience hears, and it works without the plugin: switching a mic there flips its OBS audio track 1 (an unwired mic still records to its own isolated track), and for any other source it flips track 1 on that input, with the slider driving its OBS fader both ways — drag a fader in OBS and the matrix follows.

## 1. Audio Monitor: installed for you

Headset mixes need Exeldro's **Audio Monitor** plugin inside OBS, and the desktop app ships with it: on first start the hub drops it into OBS's plugin folder, and the Sound tab tells you to restart OBS once. After that, headsets just work. If you run the hub by itself (no desktop app) or on Linux, install it by hand from the [OBS forum](https://obsproject.com/forum/resources/audio-monitor.1186/) and restart OBS; the Sound tab links there until the plugin is loaded. Mics, the Stream column and the recording work without it. A plugin you installed yourself is never overwritten; the app only manages the copy it installed.

## 2. Plug in one output per person

Every headset needs its own output device, because one device plays one mix. Cheap USB-C or USB-A headphone adapters work well: each shows up as its own device. An interface with several headphone outputs usually shows up as one device, so it can carry only one mix unless its own software splits the outputs into separate devices.

Give each adapter a clear name if your computer allows it (on a Mac, Audio MIDI Setup). The hub finds a device by its name.

## 3. Wire it up in the dashboard

Open the **Sound** tab (⌘2) and scroll to **Headsets**:

1. Under **Add a headset**, type a name (for example "Guest phones"), pick who wears it, and pick the output. On a Mac the list comes from the computer; click **Refresh outputs** after plugging in a new adapter. On other systems, type the device name exactly as the system shows it.
2. The new headset hears every source at 0 dB — except camera audio, which starts switched off, since a camera mic is usually backup. Each row is a source, the first column is the **Stream**, and each column after it is a headset.
3. Use the switch in a cell to take a source out of that mix, and the slider to set its level. The cell for the wearer's own mic is marked **self**. Hearing your own voice helps you judge your level, but it arrives slightly late, so some people prefer it lower or off.
4. Each source says where it comes from: mics show their OBS input, camera audio is named after its camera and marked **camera**, and a source that is off-screen or silent right now is marked **silent**. Click **Rename** on a row to give a source a display name ("Walk-in playlist" instead of "VLC playlist"); the OBS input keeps its real name, and the label survives a rename in OBS.
5. Each headset has a master level, a **Mute** button, and a **Follows** selector. Set it to *Stream mix* or another headset and that output plays exactly what the followed node plays — plug in AirPods, follow the stream, and you hear precisely what the audience hears. The column turns read-only while it follows; set it back to *Own mix* to wire it again. Loops (A follows B follows A) are refused.
6. Mute silences that headset only. Camera audio is never forced on: an off-screen camera stays silent everywhere until its scene shows.

The hub saves the list in `.streamhub/headsets.json`, labels and stream wiring included. Sources added later (a new mic, a new OBS input) join every headset switched on at 0 dB. Renaming an input in OBS keeps its settings, its label and its wiring.

## Notes

- **A headset says its device is not plugged in.** The hub could not find that output name. Plug the adapter in, click **Refresh outputs**, or fix the name in the headset's output field.
- **Turn off OBS monitoring for the mics.** If a mic's monitoring is set to "Monitor" or "Both" in the mixer, OBS also plays it to its own monitoring device. That is a second copy, on top of the headset mix.
- **Removing a headset** removes its filters from every source. Filters you added yourself are never touched.
- **OBS offline:** the headsets keep their settings and show "OBS is not connected". When OBS comes back, the hub puts the filters and the stream wiring back as they were.
