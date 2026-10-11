import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioDevices, AudioLevels, AudioState, Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { dbToMul, FakeObsAudio, makeInput } from '../testing/fake-obs-audio';
import { FakeTimer } from '../testing/timer';
import type { AudioConfig } from './config';
import { AudioService, DEFAULT_SOUNDCHECK_S, LEVELS_MS } from './service';

let bus: Bus;
let obs: FakeObsAudio;
let timer: FakeTimer;
let clock: number;
let config: AudioConfig;
let saved: AudioConfig[];
let levels: AudioLevels[];
let svc: AudioService;

beforeEach(() => {
  bus = new Bus();
  obs = new FakeObsAudio();
  obs.inputs.set('Host mic', makeInput());
  obs.inputs.set('Guest mic', makeInput({ active: false }));
  timer = new FakeTimer();
  clock = 1_000_000;
  saved = [];
  levels = [];
  config = {
    targetDb: -20,
    mics: [
      { id: 'host', name: 'Host', input: 'Host mic', channel: 'both' },
      { id: 'guest', name: 'Guest', input: 'Guest mic', channel: 'right' },
    ],
  };
  bus.subscribe(['audio.levels'], (e) => levels.push(e.payload as AudioLevels));
  svc = new AudioService({
    bus,
    obs,
    config,
    save: async (c) => void saved.push(structuredClone(c)),
    timer,
    now: () => clock,
    log: () => {},
  });
  svc.start();
});

const retained = <T>(type: string) => (bus.retainedFor([type]).at(-1) as Envelope | undefined)?.payload as T;
const state = () => retained<AudioState>('audio.state');
const devices = () => retained<AudioDevices>('audio.devices');
const mic = (id: string) => state().mics.find((m) => m.id === id)!;
const send = (type: string, payload: unknown) => {
  const r = bus.publish({ type, payload, source: 'dashboard' });
  if (!r.ok) throw new Error(r.error);
};
const connect = async () => {
  bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
  await svc.idle();
};

describe('AudioService', () => {
  it('lists the mics as offline with their tracks before OBS connects', () => {
    expect(state().mics.map((m) => [m.id, m.status, m.track])).toEqual([
      ['host', 'offline', 2],
      ['guest', 'offline', 3],
    ]);
    expect(state().recordDetail).toBe('OBS is not connected');
  });

  it('sets up each mic on connect: filter chain, isolated track, side, and recording tracks', async () => {
    await connect();
    expect(mic('host')).toMatchObject({ status: 'ok', live: true, track: 2 });
    expect(mic('guest')).toMatchObject({ status: 'ok', live: false, track: 3 });
    expect(obs.inputs.get('Host mic')!.tracks).toEqual({ '1': true, '2': true, '3': false, '4': false, '5': false, '6': false });
    expect(obs.inputs.get('Guest mic')!.tracks['3']).toBe(true);
    expect(obs.inputs.get('Guest mic')!.balance).toBe(1);
    expect(obs.inputs.get('Host mic')!.filters).toHaveLength(6);
    expect(obs.profile.get('SimpleOutput/RecTracks')).toBe('7');
    expect(obs.profile.get('AdvOut/Track2Name')).toBe('Host');
    expect(state()).toMatchObject({ recordTracks: [1, 2, 3], tracksPending: false });
    expect(state().recordDetail).toBeUndefined();
  });

  it('marks a mic missing until its OBS input appears', async () => {
    obs.inputs.delete('Guest mic');
    await connect();
    expect(mic('guest')).toMatchObject({ status: 'missing', detail: 'No OBS input named "Guest mic"' });
    obs.inputs.set('Guest mic', makeInput());
    obs.emit('InputCreated', { inputName: 'Guest mic' });
    await svc.idle();
    expect(mic('guest').status).toBe('ok');
  });

  it('applies fader, mute, monitoring, sync and filter changes to OBS', async () => {
    await connect();
    send('audio.cmd.set', {
      id: 'host',
      volumeDb: -6,
      muted: true,
      monitor: 'monitor',
      syncOffsetMs: 40,
      filters: { compressor: { ratio: 6 }, gate: { enabled: true } },
    });
    await svc.idle();
    const input = obs.inputs.get('Host mic')!;
    expect(input).toMatchObject({ volumeDb: -6, muted: true, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY', syncOffset: 40 });
    expect(input.filters.find((f) => f.name === 'streamhub compressor')!.settings.ratio).toBe(6);
    expect(input.filters.find((f) => f.name === 'streamhub gate')!.enabled).toBe(true);
    expect(mic('host')).toMatchObject({ volumeDb: -6, muted: true, monitor: 'monitor', syncOffsetMs: 40 });
    expect(mic('host').filters.compressor.ratio).toBe(6);
    expect(mic('host').filters.gate.enabled).toBe(true);
  });

  it('follows changes made in OBS itself', async () => {
    await connect();
    obs.inputs.get('Host mic')!.volumeDb = -12;
    obs.emit('InputVolumeChanged', { inputName: 'Host mic', inputVolumeDb: -12 });
    obs.inputs.get('Guest mic')!.active = true;
    obs.emit('InputActiveStateChanged', { inputName: 'Guest mic', videoActive: true });
    obs.inputs.get('Host mic')!.filters.find((f) => f.name === 'streamhub gain')!.settings.db = 5;
    obs.emit('SourceFilterSettingsChanged', { sourceName: 'Host mic', filterName: 'streamhub gain', filterSettings: { db: 5 } });
    await svc.idle();
    expect(mic('host').volumeDb).toBe(-12);
    expect(mic('guest').live).toBe(true);
    expect(mic('host').filters.gain.db).toBe(5);
  });

  it('applies filter echoes without reading the chain back from OBS', async () => {
    await connect();
    obs.calls = [];
    obs.emit('SourceFilterSettingsChanged', { sourceName: 'Host mic', filterName: 'streamhub gate', filterSettings: { open_threshold: -20 } });
    obs.emit('SourceFilterEnableStateChanged', { sourceName: 'Host mic', filterName: 'streamhub limiter', filterEnabled: false });
    await svc.idle();
    expect(mic('host').filters.gate.openDb).toBe(-20);
    expect(mic('host').filters.limiter.enabled).toBe(false);
    // No GetSourceFilterList, no GetSourceFilter: the echo carried everything.
    expect(obs.callsOf('GetSourceFilter')).toEqual([]);
    expect(obs.callsOf('GetSourceFilterList')).toEqual([]);
  });

  it('does not re-read the chain when a headset send changes', async () => {
    await connect();
    obs.calls = [];
    obs.emit('SourceFilterSettingsChanged', { sourceName: 'Host mic', filterName: 'streamhub hp cohost' });
    obs.emit('SourceFilterCreated', { sourceName: 'Host mic', filterName: 'streamhub hp cohost' });
    await svc.idle();
    expect(obs.callsOf('GetSourceFilterList')).toEqual([]);
  });

  it('sends meter levels per mic at most every LEVELS_MS, keeping the loudest frame', async () => {
    await connect();
    obs.meters({ 'Host mic': [[dbToMul(-30), dbToMul(-20), dbToMul(-20)]] });
    clock += 10;
    obs.meters({ 'Host mic': [[dbToMul(-18), dbToMul(-9), dbToMul(-9)]], 'Other input': [[1, 1, 1]] });
    clock += LEVELS_MS;
    obs.meters({ 'Host mic': [[dbToMul(-40), dbToMul(-30), dbToMul(-30)]] });
    expect(levels).toEqual([
      { levels: { host: { peakDb: -20, rmsDb: -30 }, guest: { peakDb: -100, rmsDb: -100 } } },
      { levels: { host: { peakDb: -9, rmsDb: -18 }, guest: { peakDb: -100, rmsDb: -100 } } },
    ]);
  });

  it('keeps track changes for the next recording while OBS is recording', async () => {
    obs.recording = true;
    await connect();
    expect(state().tracksPending).toBe(true);
    expect(obs.profile.get('SimpleOutput/RecTracks')).toBe('1');
    obs.recording = false;
    obs.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    await svc.idle();
    expect(state().tracksPending).toBe(false);
    expect(obs.profile.get('SimpleOutput/RecTracks')).toBe('7');
  });

  it('goes offline when OBS disconnects', async () => {
    await connect();
    bus.publish({ type: 'obs.connection', payload: { connected: false }, source: 'obs' });
    expect(state().mics.every((m) => m.status === 'offline' && !m.live)).toBe(true);
  });

  it('saves the sound check target and follows renamed OBS inputs', async () => {
    await connect();
    send('audio.cmd.setTarget', { targetDb: -16 });
    obs.emit('InputNameChanged', { oldInputName: 'Host mic', inputName: 'Host lav' });
    await svc.idle();
    expect(state().targetDb).toBe(-16);
    // Both changes share one debounced save.
    expect(saved).toEqual([]);
    timer.fire(AudioService.SAVE_DELAY_MS);
    expect(saved.at(-1)!.mics[0]!.input).toBe('Host lav');
    expect(saved.at(-1)!.targetDb).toBe(-16);
  });
});

describe('sound check', () => {
  const speak = (rmsDb: number, frames: number) => {
    for (let i = 0; i < frames; i++) obs.meters({ 'Host mic': [[dbToMul(rmsDb), dbToMul(rmsDb + 8), dbToMul(rmsDb + 10)]] });
  };

  it('listens with dynamics off, then sets the gain to the target and turns dynamics back on', async () => {
    await connect();
    obs.inputs.get('Host mic')!.volumeDb = -8;
    send('audio.cmd.soundcheck', { id: 'host', action: 'start' });
    await svc.idle();
    const input = obs.inputs.get('Host mic')!;
    const enabled = (name: string) => input.filters.find((f) => f.name === `streamhub ${name}`)!.enabled;
    expect(input.volumeDb).toBe(0);
    expect(enabled('compressor')).toBe(false);
    expect(enabled('limiter')).toBe(false);
    expect(mic('host').soundcheck).toEqual({ state: 'listening', until: clock + DEFAULT_SOUNDCHECK_S * 1000 });

    speak(-32, 40);
    timer.fire(DEFAULT_SOUNDCHECK_S * 1000);
    await svc.idle();
    expect(input.filters.find((f) => f.name === 'streamhub gain')!.settings.db).toBe(12);
    expect(enabled('compressor')).toBe(true);
    expect(enabled('limiter')).toBe(true);
    expect(enabled('gate')).toBe(false);
    expect(mic('host').soundcheck).toEqual({ state: 'done', measuredDb: -32, gainDb: 12 });
    expect(mic('host').filters.gain).toEqual({ enabled: true, db: 12 });
  });

  it('refuses a muted mic and restores the dynamics when cancelled', async () => {
    await connect();
    obs.inputs.get('Host mic')!.muted = true;
    obs.emit('InputMuteStateChanged', { inputName: 'Host mic', inputMuted: true });
    send('audio.cmd.soundcheck', { id: 'host', action: 'start' });
    expect(mic('host').soundcheck).toEqual({ state: 'failed', detail: 'Unmute the mic first' });

    send('audio.cmd.soundcheck', { id: 'guest', action: 'start', seconds: 5 });
    await svc.idle();
    send('audio.cmd.soundcheck', { id: 'guest', action: 'cancel' });
    await svc.idle();
    expect(timer.queue).toEqual([]);
    expect(obs.inputs.get('Guest mic')!.filters.find((f) => f.name === 'streamhub compressor')!.enabled).toBe(true);
    expect(mic('guest').soundcheck).toBeUndefined();
  });

  it('turns the dynamics back on at reconnect when OBS dropped mid-check', async () => {
    await connect();
    send('audio.cmd.soundcheck', { id: 'host', action: 'start' });
    await svc.idle();
    bus.publish({ type: 'obs.connection', payload: { connected: false }, source: 'obs' });
    expect(mic('host').soundcheck?.state).toBe('failed');
    await connect();
    expect(obs.inputs.get('Host mic')!.filters.find((f) => f.name === 'streamhub limiter')!.enabled).toBe(true);
  });
});

describe('adding and removing mics', () => {
  it('lists capture devices through an existing input and OBS audio inputs that are not mics yet', async () => {
    obs.inputs.set('Desk mic', makeInput());
    await connect();
    send('audio.cmd.listDevices', {});
    await svc.idle();
    expect(devices()).toEqual({
      devices: [
        { id: 'default', name: 'Default' },
        { id: 'AppleUSBAudioEngine:RODE:NT-USB', name: 'Rode NT-USB' },
      ],
      inputs: ['Desk mic'],
    });
    expect(obs.callsOf('CreateInput')).toEqual([]);
  });

  it('borrows a short-lived probe input when OBS has no capture input yet', async () => {
    obs.inputs.clear();
    await connect();
    send('audio.cmd.listDevices', {});
    await svc.idle();
    expect(devices().devices).toHaveLength(2);
    expect(obs.callsOf('CreateInput')[0]).toMatchObject({ inputName: 'streamhub device probe', sceneItemEnabled: false });
    expect(obs.inputs.has('streamhub device probe')).toBe(false);
  });

  it('creates an OBS input for a device in the mics scene and gives it the next track', async () => {
    await connect();
    send('audio.cmd.add', { name: 'Guest', from: { kind: 'device', device: 'AppleUSBAudioEngine:RODE:NT-USB' } });
    await svc.idle();
    expect(obs.scenes.get('streamhub mics')).toEqual(['Guest']);
    expect(obs.inputs.get('Guest')!.settings).toEqual({ device_id: 'AppleUSBAudioEngine:RODE:NT-USB' });
    expect(mic('guest-2')).toMatchObject({ input: 'Guest', track: 4, status: 'ok' });
    expect(saved.at(-1)!.mics.map((m) => m.id)).toEqual(['host', 'guest', 'guest-2']);
    expect(obs.profile.get('AdvOut/Track4Name')).toBe('Guest');
  });

  it('adopts an existing OBS input and refuses one that is already a mic', async () => {
    obs.inputs.set('Desk mic', makeInput());
    await connect();
    send('audio.cmd.add', { name: 'Desk', channel: 'left', from: { kind: 'input', input: 'Desk mic' } });
    await svc.idle();
    expect(mic('desk')).toMatchObject({ input: 'Desk mic', channel: 'left', track: 4 });
    expect(obs.inputs.get('Desk mic')!.balance).toBe(0);
    send('audio.cmd.add', { name: 'Again', from: { kind: 'input', input: 'Host mic' } });
    await svc.idle();
    expect(devices().detail).toMatch(/already a mic/);
  });

  it('says when a mic gets no isolated track', async () => {
    for (const n of [3, 4, 5, 6]) {
      obs.inputs.set(`Mic ${n}`, makeInput());
      config.mics.push({ id: `mic-${n}`, name: `Mic ${n}`, input: `Mic ${n}`, channel: 'both' });
    }
    svc = new AudioService({ bus, obs, config, save: async () => {}, timer, now: () => clock, log: () => {} });
    svc.start();
    await connect();
    expect(state().mics.map((m) => m.track)).toEqual([2, 3, 4, 5, 6, null]);
    expect(obs.inputs.get('Mic 6')!.tracks).toEqual({ '1': true, '2': false, '3': false, '4': false, '5': false, '6': false });
  });

  it('removes a mic, takes it off its isolated track and moves later mics up', async () => {
    obs.inputs.set('Desk mic', makeInput());
    config.mics.push({ id: 'desk', name: 'Desk', input: 'Desk mic', channel: 'both' });
    svc = new AudioService({ bus, obs, config, save: async (c) => void saved.push(structuredClone(c)), timer, now: () => clock, log: () => {} });
    svc.start();
    await connect();
    send('audio.cmd.remove', { id: 'guest' });
    await svc.idle();
    expect(state().mics.map((m) => [m.id, m.track])).toEqual([
      ['host', 2],
      ['desk', 3],
    ]);
    expect(obs.inputs.get('Guest mic')!.tracks['3']).toBe(false);
    expect(obs.inputs.get('Desk mic')!.tracks['3']).toBe(true);
    expect(saved.at(-1)!.mics.map((m) => m.id)).toEqual(['host', 'desk']);
  });

  it('adds the mics scene to every scene that lacks it', async () => {
    obs.scenes.set('Ending', []);
    await connect();
    send('audio.cmd.nest', {});
    await svc.idle();
    expect(obs.scenes.get('Main')).toEqual(['streamhub mics']);
    expect(obs.scenes.get('Ending')).toEqual(['streamhub mics']);
    expect(devices().detail).toBe('Added the mics to 2 scenes.');
    send('audio.cmd.nest', { scene: 'Main' });
    await svc.idle();
    expect(devices().detail).toBe('Every scene already has the mics.');
  });
});
