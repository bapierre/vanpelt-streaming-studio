import { describe, expect, it } from 'vitest';
import { MIN_SPEECH_FRAMES, SpeechMeter } from './soundcheck';

const talk = (meter: SpeechMeter, rmsDb: number, frames: number, inputPeakDb = rmsDb + 10) => {
  for (let i = 0; i < frames; i++) meter.add({ rmsDb, peakDb: rmsDb + 8, inputPeakDb });
};

describe('SpeechMeter', () => {
  it('sets the gain that brings the median speech level to the target', () => {
    const m = new SpeechMeter();
    talk(m, -32, 30);
    talk(m, -70, 50); // pauses between sentences
    talk(m, -10, 3, -4); // a laugh
    expect(m.result(-20, 2)).toEqual({ ok: true, measuredDb: -32, gainDb: 14 });
  });

  it('fails when nobody spoke', () => {
    const m = new SpeechMeter();
    talk(m, -70, 200);
    talk(m, -30, MIN_SPEECH_FRAMES - 1);
    expect(m.result(-20, 0)).toMatchObject({ ok: false });
  });

  it('caps the change and says to adjust the hardware when the mic is far too quiet', () => {
    const m = new SpeechMeter();
    talk(m, -48, 40);
    const r = m.result(-20, 0);
    expect(r).toMatchObject({ ok: true, gainDb: 20 });
    expect(r.detail).toMatch(/turn up the gain on the mic/);
  });

  it('warns when the mic clipped before reaching OBS', () => {
    const m = new SpeechMeter();
    talk(m, -12, 40, 0);
    const r = m.result(-20, 0);
    expect(r).toMatchObject({ ok: true, gainDb: -8 });
    expect(r.detail).toMatch(/clipped before OBS/);
  });
});
