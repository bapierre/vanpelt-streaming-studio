import { describe, expect, it } from 'vitest';
import { dbToMonitorVolume, headsetFilterName, headsetIdOfFilter, isHeadsetFilter, monitorVolumeToDb } from './monitor';

describe('Audio Monitor volume curve', () => {
  it('maps the ends of the fader', () => {
    expect(dbToMonitorVolume(0)).toBe(100);
    expect(dbToMonitorVolume(-96)).toBe(0);
    expect(dbToMonitorVolume(-200)).toBe(0);
    expect(monitorVolumeToDb(100)).toBe(0);
    expect(monitorVolumeToDb(0)).toBe(-Infinity);
  });

  it('matches values worked out by hand from the plugin formula', () => {
    // def = (−log10(−db + 6) + log10(102)) / (log10(102) − log10(6))
    // −6 dB: (−log10 12 + log10 102) / log10 17 = log10 8.5 / log10 17 ≈ 0.75534
    expect(dbToMonitorVolume(-6)).toBeCloseTo(75.534, 2);
    // −60 dB: log10(102 / 66) / log10 17 ≈ 0.15364
    expect(dbToMonitorVolume(-60)).toBeCloseTo(15.364, 2);
    // 50 %: db = −102 · 17^−0.5 + 6 ≈ −18.739
    expect(monitorVolumeToDb(50)).toBeCloseTo(-18.739, 2);
  });

  it('round-trips through the plugin readback', () => {
    for (const db of [-0.5, -3, -12, -24, -48, -60, -90]) {
      expect(monitorVolumeToDb(dbToMonitorVolume(db))).toBeCloseTo(db, 6);
    }
  });
});

describe('headset filter names', () => {
  it('recognises its own filters and nothing else', () => {
    expect(headsetFilterName('cohost')).toBe('streamhub hp cohost');
    expect(isHeadsetFilter('streamhub hp cohost')).toBe(true);
    expect(isHeadsetFilter('streamhub gain')).toBe(false);
    expect(isHeadsetFilter(undefined)).toBe(false);
    expect(headsetIdOfFilter('streamhub hp cohost')).toBe('cohost');
  });
});
