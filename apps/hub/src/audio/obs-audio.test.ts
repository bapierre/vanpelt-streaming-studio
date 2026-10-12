import { describe, expect, it } from 'vitest';
import { dbToMul, FakeObsAudio, makeInput } from '../testing/fake-obs-audio';
import { assignTracks, configureRecording, ensureChain, FilterDefaults, levelFromMeters, tracksFor } from './obs-audio';

const setup = () => {
  const obs = new FakeObsAudio();
  obs.inputs.set('Host mic', makeInput());
  return obs;
};

describe('ensureChain', () => {
  it('creates the streamhub filters in chain order after existing filters and reads them back', async () => {
    const obs = setup();
    obs.inputs.get('Host mic')!.filters.push({ name: 'My VST', kind: 'gain_filter', enabled: true, settings: {} });
    const { filters, unavailable } = await ensureChain(obs, 'Host mic', new FilterDefaults());
    expect(unavailable).toEqual([]);
    expect(obs.inputs.get('Host mic')!.filters.map((f) => f.name)).toEqual([
      'My VST',
      'streamhub gain',
      'streamhub noise suppression',
      'streamhub gate',
      'streamhub eq',
      'streamhub compressor',
      'streamhub limiter',
    ]);
    expect(filters.gate.enabled).toBe(false);
    expect(filters.compressor).toEqual({ enabled: true, ratio: 4, thresholdDb: -18, attackMs: 6, releaseMs: 60, outputDb: 0 });
  });

  it('fills settings OBS left out with the filter defaults', async () => {
    const obs = setup();
    // OBS saves only changed values: this compressor has just the ratio set.
    obs.inputs
      .get('Host mic')!
      .filters.push({ name: 'streamhub compressor', kind: 'compressor_filter', enabled: true, settings: { ratio: 3 } });
    const { filters } = await ensureChain(obs, 'Host mic', new FilterDefaults());
    expect(filters.compressor).toMatchObject({ ratio: 3, thresholdDb: -18, releaseMs: 60 });
    expect(obs.callsOf('CreateSourceFilter').map((c) => c.filterName)).not.toContain('streamhub compressor');
  });

  it('reports filters this OBS does not have and keeps the rest', async () => {
    const obs = setup();
    obs.failing.add('CreateSourceFilter');
    const { filters, unavailable } = await ensureChain(obs, 'Host mic', new FilterDefaults());
    expect(unavailable).toHaveLength(6);
    expect(filters.gain.enabled).toBe(false);
  });

  it('clamps out-of-range values set by hand in OBS', async () => {
    const obs = setup();
    obs.inputs.get('Host mic')!.filters.push({ name: 'streamhub gain', kind: 'gain_filter', enabled: true, settings: { db: 99 } });
    const { filters } = await ensureChain(obs, 'Host mic', new FilterDefaults());
    expect(filters.gain.db).toBe(30);
  });
});

describe('tracks', () => {
  it('gives the first five mics their own track and the rest only the mix', () => {
    expect(assignTracks(7)).toEqual([2, 3, 4, 5, 6, null, null]);
    expect(tracksFor(3)).toEqual({ '1': true, '2': false, '3': true, '4': false, '5': false, '6': false });
    expect(tracksFor(null)).toEqual({ '1': true, '2': false, '3': false, '4': false, '5': false, '6': false });
    // Unwired from the stream: the mix track is off, the isolated track keeps recording.
    expect(tracksFor(3, false)).toEqual({ '1': false, '2': false, '3': true, '4': false, '5': false, '6': false });
  });
});

describe('configureRecording', () => {
  it('records the mix plus isolated tracks in simple mode and names them', async () => {
    const obs = new FakeObsAudio();
    const r = await configureRecording(
      obs,
      new Map([
        [2, 'Host'],
        [3, 'Guest'],
      ]),
    );
    expect(r).toEqual({ tracks: [1, 2, 3] });
    expect(obs.profile.get('SimpleOutput/RecTracks')).toBe('7');
    expect(obs.profile.get('AdvOut/Track1Name')).toBe('Stream mix');
    expect(obs.profile.get('AdvOut/Track3Name')).toBe('Guest');
  });

  it('uses the advanced output section when OBS is in advanced mode', async () => {
    const obs = new FakeObsAudio();
    obs.profile.set('Output/Mode', 'Advanced');
    await configureRecording(obs, new Map([[2, 'Host']]));
    expect(obs.profile.get('AdvOut/RecTracks')).toBe('3');
  });

  it('explains settings that would drop the isolated tracks', async () => {
    const obs = new FakeObsAudio();
    obs.profile.set('SimpleOutput/RecQuality', 'Stream');
    expect((await configureRecording(obs, new Map([[2, 'Host']]))).detail).toMatch(/Same as stream/);
    obs.profile.set('SimpleOutput/RecFormat2', 'flv');
    expect((await configureRecording(obs, new Map([[2, 'Host']]))).detail).toMatch(/FLV/);
  });
});

describe('levelFromMeters', () => {
  it('takes the loudest channel and converts to dBFS', () => {
    const l = levelFromMeters([
      [dbToMul(-30), dbToMul(-20), dbToMul(-10)],
      [dbToMul(-24), dbToMul(-12), dbToMul(-6)],
    ])!;
    expect(l.rmsDb).toBeCloseTo(-24);
    expect(l.peakDb).toBeCloseTo(-12);
    expect(l.inputPeakDb).toBeCloseTo(-6);
  });

  it('treats silence as -100 and ignores malformed frames', () => {
    expect(levelFromMeters([[0, 0, 0]])).toEqual({ rmsDb: -100, peakDb: -100, inputPeakDb: -100 });
    expect(levelFromMeters('nope')).toBeNull();
  });
});
