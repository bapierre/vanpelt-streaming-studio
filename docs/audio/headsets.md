# Headsets: a mix for each person

Each person on the show can hear their own mix in their own headphones: the host might want the guest louder and the music quieter, while the guest wants less of their own voice. streamhub sets this up in OBS. The audio never goes through the hub.

## How it works

Each headset is one output device on this computer, such as a USB headphone adapter or one output of an audio interface. For every source a headset should hear, the hub adds a filter called `streamhub hp <headset>` to that source in OBS. The filter comes from Exeldro's **Audio Monitor** plugin, which plays the source to any output device at its own level.

- The filter sits last on the source, after the mic filters (gain, noise suppression, EQ and the rest). Headsets hear the cleaned-up voice.
- Headset levels are separate from the stream. Moving a fader in the mixer never changes what a headset hears, and the reverse is also true.
- A muted mic is silent in every headset too.
- The plugin can only turn a sound down, so levels go up to 0 dB. To make a whole headset louder, turn up its master level, or turn up the volume on the headphones or adapter.

## 1. Install Audio Monitor

Download it from the [OBS forum](https://obsproject.com/forum/resources/audio-monitor.1186/), install it, and restart OBS. Until it is installed, the Sound tab shows a link to it and each headset says it needs the plugin. Mics, the stream and the recording work without it.

## 2. Plug in one output per person

Every headset needs its own output device, because one device plays one mix. Cheap USB-C or USB-A headphone adapters work well: each shows up as its own device. An interface with several headphone outputs usually shows up as one device, so it can carry only one mix unless its own software splits the outputs into separate devices.

Give each adapter a clear name if your computer allows it (on a Mac, Audio MIDI Setup). The hub finds a device by its name.

## 3. Add the headsets in the dashboard

Open the **Sound** tab (⌘2) and scroll to **Headsets**:

1. Under **Add a headset**, type a name (for example "Guest phones"), pick who wears it, and pick the output. On a Mac the list comes from the computer; click **Refresh outputs** after plugging in a new adapter. On other systems, type the device name exactly as the system shows it.
2. The new headset hears every source at 0 dB. Each column is a headset, and each row is a source: the mics first, then any other OBS audio (music, a guest call, desktop sound).
3. Use the switch in a cell to take a source out of that headset, and the slider to set its level. The cell for the wearer's own mic is marked **self**. Hearing your own voice helps you judge your level, but it arrives slightly late, so some people prefer it lower or off.
4. Each headset has a master level and a **Mute** button. Mute silences that headset only.

The hub saves the list in `.streamhub/headsets.json`. Sources added later (a new mic, a new OBS input) join every headset switched on at 0 dB. Renaming an input in OBS keeps its settings.

## Notes

- **A headset says its device is not plugged in.** The hub could not find that output name. Plug the adapter in, click **Refresh outputs**, or fix the name in the headset's output field.
- **Turn off OBS monitoring for the mics.** If a mic's monitoring is set to "Monitor" or "Both" in the mixer, OBS also plays it to its own monitoring device. That is a second copy, on top of the headset mix.
- **Removing a headset** removes its filters from every source. Filters you added yourself are never touched.
- **OBS offline:** the headsets keep their settings and show "OBS is not connected". When OBS comes back, the hub puts the filters back as they were.
