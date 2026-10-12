import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioState, Envelope, HeadsetsState, MicState } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { FakeObsAudio, makeInput } from '../testing/fake-obs-audio';
import { FakeTimer } from '../testing/timer';
import type { HeadsetsConfig } from './config';
import { dbToMonitorVolume } from './monitor';
import { SAVE_DELAY_MS, HeadsetService } from './service';

let bus: Bus;
let obs: FakeObsAudio;
let config: HeadsetsConfig;
let saved: HeadsetsConfig[];
let logs: string[];
let svc: HeadsetService;
let timer: FakeTimer;

const mic = (id: string, input: string, over: Partial<MicState> = {}): MicState => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  input,
  channel: 'both',
  track: 2,
  status: 'ok',
  live: true,
  onStream: true,
  volumeDb: 0,
  muted: false,
  monitor: 'off',
  syncOffsetMs: 0,
  filters: {
    gain: { enabled: true, db: 0 },
    denoise: { enabled: true, method: 'rnnoise', suppressDb: -30 },
    gate: { enabled: true, openDb: -26, closeDb: -32, attackMs: 25, holdMs: 200, releaseMs: 150 },
    eq: { enabled: false, low: 0, mid: 0, high: 0 },
    compressor: { enabled: true, ratio: 4, thresholdDb: -18, attackMs: 6, releaseMs: 60, outputDb: 0 },
    limiter: { enabled: true, thresholdDb: -3, releaseMs: 60 },
  },
  ...over,
});

const audioState = (mics: MicState[]): AudioState => ({ mics, targetDb: -20, recordTracks: [1, 2], tracksPending: false });

beforeEach(() => {
  bus = new Bus();
  obs = new FakeObsAudio();
  // Mic inputs already carry the audio service's chain.
  obs.inputs.set('Host mic', makeInput({ filters: [{ name: 'streamhub gain', kind: 'gain_filter', enabled: true, settings: {} }] }));
  obs.inputs.set('Guest mic', makeInput());
  obs.inputs.set('Music', makeInput({ kind: 'ffmpeg_source' }));
  saved = [];
  logs = [];
  config = { headsets: [], labels: {}, streamSends: {} };
  publishAudio([mic('host', 'Host mic'), mic('guest', 'Guest mic')]);
  timer = new FakeTimer();
  svc = new HeadsetService({
    bus,
    obs,
    config,
    save: async (c) => void saved.push(structuredClone(c)),
    listOutputs: async () => ({ outputs: ['MacBook Pro Speakers', 'USB Audio'] }),
    cameras: [{ name: 'Sony A6400', source: 'Sony cam' }],
    timer,
    log: (m) => logs.push(m),
  });
  svc.start();
});

/** Saves are debounced, so they land only once the quiet period has passed. */
const flushSaves = () => timer.fire(SAVE_DELAY_MS);

function publishAudio(mics: MicState[]) {
  bus.publish({ type: 'audio.state', payload: audioState(mics), source: 'audio' });
}
const state = () => (bus.retainedFor(['headsets.state']).at(-1) as Envelope).payload as HeadsetsState;
const headset = (id: string) => state().headsets.find((h) => h.id === id)!;
const send = async (type: string, payload: unknown) => {
  const r = bus.publish({ type, payload, source: 'dashboard' });
  if (!r.ok) throw new Error(r.error);
  await svc.idle();
};
const connect = async () => {
  bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
  await svc.idle();
};
const disconnect = async () => {
  bus.publish({ type: 'obs.connection', payload: { connected: false }, source: 'obs' });
  await svc.idle();
};
const hp = (input: string, id = 'cohost') => obs.inputs.get(input)!.filters.find((f) => f.name === `streamhub hp ${id}`);
const addCohost = () => send('headsets.cmd.add', { name: 'Cohost', device: 'USB Audio', owner: 'guest' });

describe('HeadsetService', () => {
  it('shows headsets as offline, with the output devices, before OBS connects', async () => {
    await svc.idle();
    await addCohost();
    expect(state().outputs).toEqual(['MacBook Pro Speakers', 'USB Audio']);
    expect(state().plugin).toBeNull();
    expect(headset('cohost')).toMatchObject({ status: 'offline', detail: 'OBS is not connected' });
    expect(obs.calls).toEqual([]);
  });

  it('lists mics first, then other OBS audio, and skips inputs without audio', async () => {
    obs.inputs.set('Logo', makeInput({ kind: 'image_source' }));
    const realCall = obs.call.bind(obs);
    obs.call = async (type, data = {}) => {
      if (type === 'GetInputMute' && data.inputName === 'Logo') throw new Error('The specified input does not support audio.');
      return realCall(type, data);
    };
    await connect();
    expect(state().sources).toEqual([
      { key: 'mic:host', name: 'Host', kind: 'mic', detail: 'Host mic', live: true },
      { key: 'mic:guest', name: 'Guest', kind: 'mic', detail: 'Guest mic', live: true },
      { key: 'obs:Music', name: 'Music', kind: 'obs', live: true },
    ]);
    expect(state().plugin).toBe(true);
  });

  it('gives a new headset every source at 0 dB, their own mic included, and plays it after the chain', async () => {
    await connect();
    await addCohost();
    expect(headset('cohost')).toMatchObject({ status: 'ok', owner: 'guest', masterDb: 0, muted: false });
    expect(headset('cohost').sends).toEqual({
      'mic:host': { on: true, db: 0 },
      'mic:guest': { on: true, db: 0 },
      'obs:Music': { on: true, db: 0 },
    });
    const host = obs.inputs.get('Host mic')!.filters;
    expect(host.map((f) => f.name)).toEqual(['streamhub gain', 'streamhub hp cohost']);
    expect(host[1]).toMatchObject({
      kind: 'audio_monitor',
      enabled: true,
      settings: { device: 'USB Audio', deviceName: 'USB Audio', volume: 100, mute: 0, linked: false },
    });
    expect(hp('Guest mic')).toBeDefined();
    expect(hp('Music')).toBeDefined();
    flushSaves();
    expect(saved.at(-1)!.headsets[0]!.id).toBe('cohost');
  });

  it('sets the plugin volume from send plus master, and only sends what changed', async () => {
    await connect();
    await addCohost();
    obs.calls = [];
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'mic:host', db: -6 });
    await send('headsets.cmd.update', { id: 'cohost', masterDb: -6 });
    expect(hp('Host mic')!.settings.volume).toBeCloseTo(dbToMonitorVolume(-12), 6);
    expect(hp('Guest mic')!.settings.volume).toBeCloseTo(dbToMonitorVolume(-6), 6);
    const writes = obs.callsOf('SetSourceFilterSettings');
    // One write for the send, then one per source for the master; never the device again.
    expect(writes).toHaveLength(4);
    expect(writes.every((w) => !('device' in (w.filterSettings as object)))).toBe(true);
    expect(obs.callsOf('CreateSourceFilter')).toEqual([]);
  });

  it('switches a send off and on by disabling its filter', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'obs:Music', on: false });
    expect(hp('Music')!.enabled).toBe(false);
    expect(hp('Host mic')!.enabled).toBe(true);
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'obs:Music', on: true });
    expect(hp('Music')!.enabled).toBe(true);
  });

  it('mutes the whole headset by disabling all its filters', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.update', { id: 'cohost', muted: true });
    expect(['Host mic', 'Guest mic', 'Music'].map((i) => hp(i)!.enabled)).toEqual([false, false, false]);
  });

  it('carries a mic mute into every headset, because the plugin ignores OBS mute', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.add', { name: 'Host', device: 'MacBook Pro Speakers', owner: 'host' });
    publishAudio([mic('host', 'Host mic', { muted: true }), mic('guest', 'Guest mic')]);
    await svc.idle();
    expect(hp('Host mic', 'cohost')!.enabled).toBe(false);
    expect(hp('Host mic', 'host')!.enabled).toBe(false);
    expect(hp('Guest mic', 'host')!.enabled).toBe(true);
    publishAudio([mic('host', 'Host mic'), mic('guest', 'Guest mic')]);
    await svc.idle();
    expect(hp('Host mic', 'cohost')!.enabled).toBe(true);
  });

  it('carries OBS mute on other audio too', async () => {
    await connect();
    await addCohost();
    await obs.call('SetInputMute', { inputName: 'Music', inputMuted: true });
    await svc.idle();
    expect(hp('Music')!.enabled).toBe(false);
  });

  it('moves the device when the headset changes output', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.update', { id: 'cohost', device: 'MacBook Pro Speakers' });
    expect(hp('Host mic')!.settings).toMatchObject({ device: 'MacBook Pro Speakers', deviceName: 'MacBook Pro Speakers' });
  });

  it('removes a headset and its filters', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.remove', { id: 'cohost' });
    expect(state().headsets).toEqual([]);
    expect(['Host mic', 'Guest mic', 'Music'].map((i) => hp(i))).toEqual([undefined, undefined, undefined]);
    expect(obs.inputs.get('Host mic')!.filters.map((f) => f.name)).toEqual(['streamhub gain']);
  });

  it('adds mics and inputs that appear later to every headset, switched on', async () => {
    await connect();
    await addCohost();
    await obs.call('CreateInput', { inputName: 'Guest call', inputKind: 'browser_source', sceneName: 'Main' });
    await svc.idle();
    expect(headset('cohost').sends['obs:Guest call']).toEqual({ on: true, db: 0 });
    expect(hp('Guest call')!.enabled).toBe(true);
    obs.inputs.set('Third mic', makeInput());
    publishAudio([mic('host', 'Host mic'), mic('guest', 'Guest mic'), mic('third', 'Third mic')]);
    await svc.idle();
    expect(headset('cohost').sends['mic:third']).toEqual({ on: true, db: 0 });
    expect(hp('Third mic')!.enabled).toBe(true);
  });

  it('keeps a headset filter after a chain that is built later', async () => {
    await connect();
    await addCohost();
    await obs.call('CreateSourceFilter', { sourceName: 'Guest mic', filterName: 'streamhub gain', filterKind: 'gain_filter', filterSettings: {} });
    await svc.idle();
    expect(obs.inputs.get('Guest mic')!.filters.map((f) => f.name)).toEqual(['streamhub gain', 'streamhub hp cohost']);
  });

  it('follows a renamed input', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'obs:Music', db: -20 });
    const music = obs.inputs.get('Music')!;
    obs.inputs.delete('Music');
    obs.inputs.set('Playlist', music);
    obs.emit('InputNameChanged', { oldInputName: 'Music', inputName: 'Playlist' });
    await svc.idle();
    expect(headset('cohost').sends['obs:Playlist']).toEqual({ on: true, db: -20 });
    expect(headset('cohost').sends['obs:Music']).toBeUndefined();
    expect(obs.callsOf('CreateSourceFilter').filter((c) => c.sourceName === 'Playlist')).toEqual([]);
  });

  it('marks headsets no-plugin and touches no filters when Audio Monitor is missing', async () => {
    obs.filterKinds = obs.filterKinds.filter((k) => k !== 'audio_monitor');
    await connect();
    await addCohost();
    expect(state().plugin).toBe(false);
    expect(headset('cohost')).toMatchObject({ status: 'no-plugin', detail: expect.stringContaining('Audio Monitor') });
    expect(obs.callsOf('CreateSourceFilter')).toEqual([]);
  });

  it('flags a headset whose output is not plugged in', async () => {
    await connect();
    await send('headsets.cmd.add', { name: 'Guest', device: 'Unplugged Headset' });
    expect(headset('guest').detail).toBe('"Unplugged Headset" is not plugged in');
  });

  it('goes offline when OBS disconnects and puts everything back when it returns', async () => {
    await connect();
    await addCohost();
    await disconnect();
    expect(headset('cohost').status).toBe('offline');
    // While OBS was away: the send changed, and OBS lost the filter on one input.
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'mic:host', db: -10 });
    const guest = obs.inputs.get('Guest mic')!;
    guest.filters = guest.filters.filter((f) => f.name !== 'streamhub hp cohost');
    obs.calls = [];
    await connect();
    expect(headset('cohost').status).toBe('ok');
    expect(hp('Host mic')!.settings.volume).toBeCloseTo(dbToMonitorVolume(-10), 6);
    expect(hp('Guest mic')!.enabled).toBe(true);
    expect(obs.callsOf('CreateSourceFilter').map((c) => c.sourceName)).toEqual(['Guest mic']);
  });

  it('removes filters left by a headset deleted while OBS was closed', async () => {
    obs.inputs.get('Guest mic')!.filters.push({ name: 'streamhub hp old', kind: 'audio_monitor', enabled: true, settings: {} });
    await connect();
    expect(hp('Guest mic', 'old')).toBeUndefined();
  });

  it('keeps going when one filter cannot be set', async () => {
    await connect();
    obs.failing.add('CreateSourceFilter');
    await addCohost();
    expect(logs.some((l) => l.includes("could not set Cohost's mix"))).toBe(true);
    obs.failing.clear();
    await send('headsets.cmd.update', { id: 'cohost', name: 'Cohost' });
    expect(hp('Host mic')).toBeDefined();
  });

  it('lists outputs again on request', async () => {
    await send('headsets.cmd.listOutputs', {});
    expect(state().outputs).toContain('USB Audio');
  });

  it('labels camera audio with the camera name, and it joins outputs switched off', async () => {
    obs.inputs.set('Sony cam', makeInput());
    await connect();
    await addCohost();
    expect(state().sources.find((s) => s.kind === 'camera')).toEqual({
      key: 'obs:Sony cam',
      name: 'Sony A6400',
      kind: 'camera',
      detail: 'Sony cam',
      live: true,
    });
    expect(headset('cohost').sends['obs:Sony cam']).toEqual({ on: false, db: 0 });
  });

  it('marks a camera source silent while it is off-screen', async () => {
    obs.inputs.set('Sony cam', makeInput());
    await connect();
    expect(state().sources.find((s) => s.kind === 'camera')!.live).toBe(true);
    obs.inputs.get('Sony cam')!.active = false;
    obs.emit('InputActiveStateChanged', { inputName: 'Sony cam', videoActive: false });
    await svc.idle();
    expect(state().sources.find((s) => s.kind === 'camera')!.live).toBe(false);
  });

  it('wires an OBS source into the stream on track 1, keeping its other tracks', async () => {
    await connect();
    const music = obs.inputs.get('Music')!;
    music.tracks = { '1': true, '2': false, '3': true, '4': false, '5': false, '6': false };
    music.volumeDb = -4;
    await send('headsets.cmd.setStream', { source: 'obs:Music', on: false, db: -12 });
    expect(music.tracks).toEqual({ '1': false, '2': false, '3': true, '4': false, '5': false, '6': false });
    expect(music.volumeDb).toBe(-12);
    expect(state().stream['obs:Music']).toEqual({ on: false, db: -12 });
    flushSaves();
    expect(saved.at(-1)!.streamSends['obs:Music']).toEqual({ on: false, db: -12 });
  });

  it('follows fader changes made in OBS for wired sources', async () => {
    await connect();
    await send('headsets.cmd.setStream', { source: 'obs:Music', db: -6 });
    obs.inputs.get('Music')!.volumeDb = -10;
    obs.emit('InputVolumeChanged', { inputName: 'Music', inputVolumeDb: -10 });
    expect(state().stream['obs:Music']!.db).toBe(-10);
    flushSaves();
    expect(saved.at(-1)!.streamSends['obs:Music']).toEqual({ on: true, db: -10 });
  });

  it('shows mic stream wiring from the audio state', async () => {
    await connect();
    expect(state().stream['mic:host']).toEqual({ on: true, db: 0 });
    publishAudio([mic('host', 'Host mic', { onStream: false, volumeDb: -6 }), mic('guest', 'Guest mic')]);
    await svc.idle();
    expect(state().stream['mic:host']).toEqual({ on: false, db: -6 });
  });

  it('mirrors the stream into an output and follows rewiring', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.update', { id: 'cohost', mirror: 'stream' });
    expect(headset('cohost').mirror).toBe('stream');
    expect(headset('cohost').sends['obs:Music']).toEqual({ on: true, db: 0 });
    await send('headsets.cmd.setStream', { source: 'obs:Music', on: false });
    expect(headset('cohost').sends['obs:Music']).toEqual({ on: false, db: 0 });
    // Its own sends are refused while it follows the stream.
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'obs:Music', on: true });
    expect(headset('cohost').sends['obs:Music']!.on).toBe(false);
    expect(logs.some((l) => l.includes('unfollow'))).toBe(true);
  });

  it('mirrors another output and rejects loops', async () => {
    await connect();
    await addCohost();
    await send('headsets.cmd.add', { name: 'AirPods', device: 'USB Audio' });
    await send('headsets.cmd.setSend', { id: 'cohost', source: 'obs:Music', on: false });
    await send('headsets.cmd.update', { id: 'airpods', mirror: 'cohost' });
    expect(headset('airpods').sends['obs:Music']).toEqual({ on: false, db: 0 });
    await send('headsets.cmd.update', { id: 'cohost', mirror: 'airpods' });
    expect(headset('cohost').mirror).toBeNull();
    expect(logs.some((l) => l.includes('loop'))).toBe(true);
  });

  it('renames a source with a label that survives OBS renames, and clears it', async () => {
    await connect();
    await send('headsets.cmd.renameSource', { source: 'obs:Music', name: 'Walk-in playlist' });
    expect(state().labels['obs:Music']).toBe('Walk-in playlist');
    const music = obs.inputs.get('Music')!;
    obs.inputs.delete('Music');
    obs.inputs.set('Playlist', music);
    obs.emit('InputNameChanged', { oldInputName: 'Music', inputName: 'Playlist' });
    await svc.idle();
    expect(state().labels['obs:Playlist']).toBe('Walk-in playlist');
    await send('headsets.cmd.renameSource', { source: 'obs:Playlist', name: null });
    expect(state().labels['obs:Playlist']).toBeUndefined();
  });
});
