# Mics: one track per person

Every mic is an OBS audio input. streamhub controls those inputs in OBS, so each person can be tuned on their own and recorded on their own track:

| Track | What is on it |
| --- | --- |
| 1 | The stream mix: every mic plus any other audio on track 1 in OBS, what viewers hear |
| 2–6 | One mic each, alone, for fixing levels or cutting in the edit |

OBS records at most 6 tracks, so up to **5 mics** get an isolated track. A sixth mic still works and is in the stream mix, but the dashboard marks it "Mix only". Starting and stopping the recording is the recording feature's job (`docs/setup/recording.md`); the audio service only sets up the tracks.

## 1. Plug in the mics

- **USB mics** (one person each) show up as their own audio device. Use "Whole device".
- **Audio interfaces** with two inputs, and **wireless kits** with two transmitters on one receiver, show up as one stereo device: person 1 on the left side, person 2 on the right. Add the device twice, once with "Left side" and once with "Right side". The hub creates two OBS inputs and pans each to its side, so each track only holds one person.
  - In OBS, open **Edit → Advanced Audio Properties** and tick **Mono** for both inputs. Without it, a left-side mic plays only in the left ear. OBS does not let streamhub change that setting.
- **Interfaces with more than two inputs:** streamhub can split a device into its left and right side only. Use the interface's own mixer software to send inputs 3 and 4 to a second stereo pair, or a routing tool such as Loopback, so each pair appears as its own device.

## 2. Add the mics in the dashboard

Open the **Sound** tab (⌘2):

1. Under **Add a mic**, type who uses it (for example "Host"), pick the device, pick the side, and click **Add mic**. A mic already set up in OBS can be adopted from "Existing OBS inputs" instead.
2. New inputs go into a scene called **streamhub mics**. Click **Add mics to all scenes** once to put that scene into every scene, so the mics are heard whatever scene is live. A mic that is not in the live scene shows "Not in the live scene".
3. The hub saves the list in `.streamhub/audio.json` and assigns tracks 2–6 in the order mics were added. Removing a mic moves the mics after it up one track; the track names in the recording follow the mic names, so check them before an edit.

## 3. Sound check

Each mic card has a **Sound check** button. The person talks normally for 10 seconds. The hub sets the fader to 0 dB, turns off the gate, compressor and limiter so it hears the raw voice, measures the speech level, and sets that mic's gain so speech lands on the **target** (−20 dBFS by default; change it at the top of the panel). Then it turns the filters back on. The fader stays at 0 dB, so after a check every mic starts level with the others; use the fader for changes during the show.

The mic must be unmuted for a check. One check runs at a time.

- It changes the gain by at most 20 dB. If the mic needs more, it says so: turn the gain knob on the interface or receiver up, then run the check again.
- If the voice clipped during the check, it says so: turn the hardware gain down.
- If it heard less than about a second of speech, the check fails and nothing changes.

## 4. Tune each mic

Each mic card has:

- **Volume** fader and **Mute**: the same controls as the OBS mixer. The Live tab has the same fader and Mute for each mic, for use during the show.
- **Monitoring**: hear the mic in your headphones.
- **Sync offset**: delays a mic to match a camera that runs late.
- **Voice filters**, in this order in OBS: Gain (set by the sound check), Noise suppression, Noise gate, EQ, Compressor, Limiter. The filters are named "streamhub …" in OBS; other filters you add yourself stay in place, before them.

## 5. OBS settings the hub cannot fix

The hub writes the track choices into the current OBS profile (Simple and Advanced output both work) and warns in the Audio panel when a setting would lose the tracks:

- **Recording format** must not be FLV, which holds only one audio track. MKV or MOV are the safe choices.
- **Simple output:** the recording quality must not be "Same as stream".
- **Advanced output:** the recording type must be Standard, not Custom Output (FFmpeg).

OBS reads the track settings when a recording starts. A change made while recording applies to the next recording; the panel says so.

## When OBS is not running

The mic cards show "OBS is not connected" and the controls are disabled. When OBS comes back, the hub re-applies the filters, panning and tracks. If OBS disconnects during a sound check, the check fails and the hub turns the mic's filters back on when OBS reconnects.
