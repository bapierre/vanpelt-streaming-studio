import type { AlertSound } from '@streamhub/shared';

type Note = { freq: number; at: number; length: number; type: OscillatorType; glideTo?: number };

/** Each sound is a few synthesized notes, so the overlay ships no audio files. */
export const SOUNDS: Record<Exclude<AlertSound, 'none'>, Note[]> = {
  chime: [
    { freq: 1318.5, at: 0, length: 0.9, type: 'sine' },
    { freq: 1975.5, at: 0.12, length: 1.1, type: 'sine' },
  ],
  pop: [{ freq: 620, glideTo: 180, at: 0, length: 0.14, type: 'sine' }],
  coin: [
    { freq: 987.8, at: 0, length: 0.09, type: 'square' },
    { freq: 1318.5, at: 0.08, length: 0.45, type: 'square' },
  ],
  fanfare: [
    { freq: 523.3, at: 0, length: 0.18, type: 'triangle' },
    { freq: 659.3, at: 0.15, length: 0.18, type: 'triangle' },
    { freq: 784, at: 0.3, length: 0.18, type: 'triangle' },
    { freq: 1046.5, at: 0.45, length: 0.8, type: 'triangle' },
  ],
};

/** Square waves sound much louder than sines at the same gain. */
const LOUDNESS: Record<OscillatorType, number> = {
  sine: 0.5,
  triangle: 0.45,
  square: 0.12,
  sawtooth: 0.15,
  custom: 0.3,
};

type AudioCtx = Pick<
  AudioContext,
  'currentTime' | 'destination' | 'createOscillator' | 'createGain' | 'state' | 'resume'
>;

let shared: AudioCtx | null = null;

function context(): AudioCtx | null {
  if (shared) return shared;
  const Ctor = globalThis.AudioContext;
  if (!Ctor) return null;
  shared = new Ctor();
  return shared;
}

export function playSound(
  sound: AlertSound,
  volume: number,
  ctx: AudioCtx | null = context(),
): void {
  if (sound === 'none' || volume <= 0 || !ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const start = ctx.currentTime + 0.02;
  for (const note of SOUNDS[sound]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.type;
    const t0 = start + note.at;
    const t1 = t0 + note.length;
    osc.frequency.setValueAtTime(note.freq, t0);
    if (note.glideTo) osc.frequency.exponentialRampToValueAtTime(note.glideTo, t1);
    const peak = Math.min(1, volume) * LOUDNESS[note.type];
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1 + 0.05);
  }
}
