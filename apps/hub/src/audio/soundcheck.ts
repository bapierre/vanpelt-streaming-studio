import type { Level } from './obs-audio';

/** Meter frames quieter than this are pauses or room noise, not speech. */
export const SPEECH_FLOOR_DB = -50;
/** About one second of speech at obs-websocket's 20 meter frames per second. */
export const MIN_SPEECH_FRAMES = 20;
export const MAX_GAIN_CHANGE_DB = 20;
/** At this input peak the converter before OBS is clipping and OBS cannot undo it. */
export const CLIP_DB = -0.5;

const GAIN_MIN = -30;
const GAIN_MAX = 30;

export type SoundcheckResult =
  | { ok: true; measuredDb: number; gainDb: number; detail?: string }
  | { ok: false; detail: string; measuredDb?: number };

/** Collects meter frames while someone talks, then works out the gain that brings speech to the target. */
export class SpeechMeter {
  private readonly speech: number[] = [];
  private inputPeakDb = -100;

  add(level: Level) {
    this.inputPeakDb = Math.max(this.inputPeakDb, level.inputPeakDb);
    if (level.rmsDb > SPEECH_FLOOR_DB) this.speech.push(level.rmsDb);
  }

  /** `currentGainDb` is the gain filter's value while the frames were measured. */
  result(targetDb: number, currentGainDb: number): SoundcheckResult {
    if (this.speech.length < MIN_SPEECH_FRAMES) {
      return { ok: false, detail: 'Heard almost no speech. Check the mic is on and unmuted, then talk for the whole check.' };
    }
    // The median ignores the odd shout or cough that an average would chase.
    const sorted = [...this.speech].sort((a, b) => a - b);
    const measuredDb = round1(sorted[Math.floor(sorted.length / 2)]!);
    const wanted = targetDb - measuredDb;
    const change = clamp(wanted, -MAX_GAIN_CHANGE_DB, MAX_GAIN_CHANGE_DB);
    const gainDb = round1(clamp(currentGainDb + change, GAIN_MIN, GAIN_MAX));
    const notes: string[] = [];
    if (this.inputPeakDb >= CLIP_DB) {
      notes.push('The mic clipped before OBS: turn down the gain on the mic, receiver or interface and run the check again.');
    }
    if (currentGainDb + wanted > gainDb + 0.05) {
      notes.push('Still too quiet after the largest boost: turn up the gain on the mic, receiver or interface.');
    } else if (currentGainDb + wanted < gainDb - 0.05) {
      notes.push('Still too loud after the largest cut: turn down the gain on the mic, receiver or interface.');
    }
    return { ok: true, measuredDb, gainDb, detail: notes.length ? notes.join(' ') : undefined };
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
