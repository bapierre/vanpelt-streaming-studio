import { describe, expect, it } from 'vitest';
import type { Envelope, RecordingSession } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import type { CameraConfig } from '../cameras/config';
import type { Timer } from '../util/timer';
import { CRITICAL_DISK_BYTES, ISO_FILTER, ISO_FILTER_KIND, LOW_DISK_BYTES, RecordingService, type RecordingFs } from './service';

const notFound = () => Object.assign(new Error('not found'), { code: 600 });
const GB = 1024 ** 3;

/** Fake OBS with sources and their filters, and a record output we drive by hand. */
function fakeObs(sources: string[], kinds = ['color_filter_v2', ISO_FILTER_KIND]) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const filters = new Map<string, { enabled: boolean; settings: Record<string, unknown> }>();
  const listeners = new Map<string, Array<(d: unknown) => void>>();
  let record = { outputActive: false, outputPaused: false, outputDuration: 0 };
  const obs = {
    async call(type: string, data: object = {}) {
      const d = data as Record<string, unknown>;
      calls.push([type, d]);
      const key = `${d.sourceName}/${d.filterName}`;
      switch (type) {
        case 'GetRecordDirectory':
          return { recordDirectory: '/rec' };
        case 'GetSourceFilterKindList':
          return { sourceFilterKinds: kinds };
        case 'GetRecordStatus':
          return record;
        case 'GetSourceFilter': {
          if (!sources.includes(d.sourceName as string)) throw notFound();
          const f = filters.get(key);
          if (!f) throw notFound();
          return { filterEnabled: f.enabled, filterSettings: f.settings };
        }
        case 'CreateSourceFilter':
          if (!sources.includes(d.sourceName as string)) throw notFound();
          filters.set(key, { enabled: true, settings: d.filterSettings as Record<string, unknown> });
          return {};
        case 'SetSourceFilterSettings': {
          const f = filters.get(key);
          if (!f) throw notFound();
          f.settings = { ...f.settings, ...(d.filterSettings as object) };
          return {};
        }
        case 'SetSourceFilterEnabled':
          filters.get(key)!.enabled = d.filterEnabled as boolean;
          return {};
        default:
          return {};
      }
    },
    onObs<T>(event: string, listener: (data: T) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as (d: unknown) => void]);
    },
  };
  const emit = (event: string, data: unknown) => listeners.get(event)?.forEach((l) => l(data));
  return { obs, calls, filters, emit, setRecord: (r: typeof record) => (record = r) };
}

class Timers implements Timer {
  queue: Array<{ fn: () => void; ms: number }> = [];
  set(fn: () => void, ms: number) {
    const e = { fn, ms };
    this.queue.push(e);
    return e;
  }
  clear(h: unknown) {
    this.queue = this.queue.filter((e) => e !== h);
  }
  fireAll() {
    const due = this.queue.splice(0);
    due.forEach((e) => e.fn());
  }
}

const wide: CameraConfig = { id: 'wide', name: 'Wide', driver: null, scene: 'Wide', source: 'Wide cam', driverConfig: {}, record: 'obs' };
const gopro: CameraConfig = { id: 'gopro', name: 'GoPro', driver: 'camera-gopro', scene: 'GoPro', source: 'GoPro feed', driverConfig: {}, record: 'both' };

function setup(cameras: CameraConfig[], opts: { sources?: string[]; kinds?: string[] } = {}) {
  const bus = new Bus();
  const fake = fakeObs(opts.sources ?? cameras.map((c) => c.source), opts.kinds);
  const timers = new Timers();
  let now = 1_000_000;
  const disk = { free: 100 * GB, files: [] as Array<{ path: string; mtimeMs: number }> };
  const fs: RecordingFs = {
    freeBytes: async () => disk.free,
    list: async () => disk.files,
  };
  const logs: string[] = [];
  const service = new RecordingService({ bus, obs: fake.obs, cameras, fs, timer: timers, now: () => now, log: (m) => logs.push(m) });
  const states: RecordingSession[] = [];
  const sent: Envelope[] = [];
  bus.subscribe(['recording.state'], (e) => states.push(e.payload as RecordingSession));
  bus.subscribe(['camera.driver.cmd.'], (e) => sent.push(e));
  service.start();
  const last = () => states[states.length - 1]!;
  const cam = (id: string) => last().cameras.find((c) => c.id === id)!;
  const obsUp = async () => {
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    await service.idle();
  };
  const record = async (outputState: string, outputPath?: string) => {
    fake.emit('RecordStateChanged', { outputActive: outputState.endsWith('STARTED'), outputState, outputPath: outputPath ?? null });
    await service.idle();
  };
  const cameraUp = (id: string, card?: { supported: boolean; recording: boolean; detail?: string }) => {
    bus.publish({
      type: 'camera.state',
      payload: { id, name: id, driver: 'camera-gopro', status: 'streaming', scene: id, onAir: false, controls: [] },
      source: 'hub',
    });
    bus.publish({
      type: 'camera.driver.state',
      payload: { id, status: 'streaming', controls: [], ...(card ? { card } : {}) },
      source: 'driver:camera-gopro',
    });
  };
  return {
    bus, fake, timers, disk, service, states, sent, logs, last, cam, obsUp, record, cameraUp,
    advance: (ms: number) => (now += ms),
  };
}

describe('RecordingService — camera files in OBS', () => {
  it('reports offline cameras until OBS connects', () => {
    const t = setup([wide]);
    expect(t.last()).toMatchObject({ output: 'stopped', detail: 'OBS is not connected' });
    expect(t.cam('wide')).toMatchObject({ mode: 'obs', iso: 'offline' });
  });

  it('adds a Source Record filter that follows OBS recording, named by camera id', async () => {
    const t = setup([wide]);
    await t.obsUp();
    expect(t.fake.filters.get(`Wide cam/${ISO_FILTER}`)?.settings).toEqual({
      record_mode: 3,
      path: '/rec',
      filename_formatting: '%CCYY-%MM-%DD %hh-%mm-%ss wide',
    });
    expect(t.last()).toMatchObject({ output: 'stopped', directory: '/rec' });
    expect(t.last().detail).toBeUndefined();
    expect(t.cam('wide').iso).toBe('ready');
  });

  it('updates and re-enables an existing filter instead of adding a second one', async () => {
    const t = setup([wide]);
    t.fake.filters.set(`Wide cam/${ISO_FILTER}`, { enabled: false, settings: { record_mode: 0, encoder: 'x264' } });
    await t.obsUp();
    expect(t.fake.calls.map(([type]) => type)).not.toContain('CreateSourceFilter');
    expect(t.fake.filters.get(`Wide cam/${ISO_FILTER}`)).toMatchObject({
      enabled: true,
      settings: { record_mode: 3, encoder: 'x264' },
    });
  });

  it('explains how to install the plugin when OBS lacks it', async () => {
    const t = setup([wide], { kinds: ['color_filter_v2'] });
    await t.obsUp();
    expect(t.cam('wide')).toMatchObject({ iso: 'no-plugin', detail: expect.stringContaining('Source Record') });
    expect(t.fake.calls.map(([type]) => type)).not.toContain('CreateSourceFilter');
  });

  it('flags a camera whose OBS source is missing', async () => {
    const t = setup([wide], { sources: [] });
    await t.obsUp();
    expect(t.cam('wide')).toMatchObject({ iso: 'no-source', detail: 'OBS source "Wide cam" not found' });
  });

  it('turns off an existing filter for a camera that no longer records in OBS', async () => {
    const t = setup([{ ...wide, record: 'off' }]);
    t.fake.filters.set(`Wide cam/${ISO_FILTER}`, { enabled: true, settings: { record_mode: 3 } });
    await t.obsUp();
    expect(t.fake.filters.get(`Wide cam/${ISO_FILTER}`)?.settings.record_mode).toBe(0);
    expect(t.cam('wide').iso).toBeUndefined();
  });

  it('picks up a recording that was already running', async () => {
    const t = setup([wide]);
    t.fake.setRecord({ outputActive: true, outputPaused: false, outputDuration: 60_000 });
    await t.obsUp();
    expect(t.last()).toMatchObject({ output: 'recording', startedAt: 940_000 });
    expect(t.cam('wide').iso).toBe('recording');
  });
});

describe('RecordingService — a session', () => {
  it('follows OBS through start, pause and stop, then lists every file', async () => {
    const t = setup([wide, gopro]);
    await t.obsUp();
    t.cameraUp('gopro', { supported: true, recording: false });
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTING');
    expect(t.last().output).toBe('starting');
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTED');
    expect(t.last()).toMatchObject({ output: 'recording', startedAt: 1_000_000 });
    expect(t.sent.map((e) => e.payload)).toEqual([{ id: 'gopro', on: true }]);

    t.cameraUp('gopro', { supported: true, recording: true });
    expect(t.cam('gopro')).toMatchObject({ iso: 'recording', card: 'recording' });
    await t.record('OBS_WEBSOCKET_OUTPUT_PAUSED');
    expect(t.last().output).toBe('paused');
    await t.record('OBS_WEBSOCKET_OUTPUT_RESUMED');

    t.advance(60_000);
    t.disk.files = [
      { path: '/rec/2026-10-11 20-00-00 wide.mkv', mtimeMs: 1_060_000 },
      { path: '/rec/2026-10-11 20-00-00 gopro.mkv', mtimeMs: 1_060_000 },
      { path: '/rec/2026-10-10 19-00-00 wide.mkv', mtimeMs: 500_000 }, // an older session
      { path: '/rec/notes wide-angle.txt', mtimeMs: 1_060_000 },
    ];
    await t.record('OBS_WEBSOCKET_OUTPUT_STOPPED', '/rec/2026-10-11 20-00-00.mkv');
    expect(t.sent.map((e) => e.payload)).toEqual([{ id: 'gopro', on: true }, { id: 'gopro', on: false }]);
    expect(t.last().output).toBe('stopped');
    expect(t.last().startedAt).toBeUndefined();
    expect(t.last().lastSession).toEqual({
      endedAt: 1_060_000,
      files: [
        { kind: 'program', label: 'Program (stream mix + mic tracks)', location: '/rec/2026-10-11 20-00-00.mkv' },
        { kind: 'camera', cameraId: 'wide', label: 'Wide', location: '/rec/2026-10-11 20-00-00 wide.mkv' },
        { kind: 'camera', cameraId: 'gopro', label: 'GoPro', location: '/rec/2026-10-11 20-00-00 gopro.mkv' },
        { kind: 'card', cameraId: 'gopro', label: 'GoPro (card)', location: "On GoPro's card" },
      ],
    });
  });

  it('does not list a card file when the card never started', async () => {
    const t = setup([gopro]);
    await t.obsUp();
    t.cameraUp('gopro', { supported: true, recording: false });
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTED');
    t.cameraUp('gopro', { supported: true, recording: false, detail: 'The GoPro is not recording to its card.' });
    expect(t.cam('gopro')).toMatchObject({ card: 'error', detail: expect.stringContaining('not recording') });
    await t.record('OBS_WEBSOCKET_OUTPUT_STOPPED', '/rec/a.mkv');
    expect(t.last().lastSession?.files.map((f) => f.kind)).toEqual(['program']);
  });

  it('marks card recording unsupported for cameras without a capable driver', async () => {
    const t = setup([{ ...wide, record: 'card' }, gopro]);
    await t.obsUp();
    t.cameraUp('gopro');
    expect(t.cam('wide')).toMatchObject({ card: 'unsupported', detail: expect.stringContaining('no driver') });
    expect(t.cam('gopro')).toMatchObject({ card: 'unsupported' });
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTED');
    // Only cameras with a driver get the command; the driver itself says if it cannot.
    expect(t.sent.map((e) => e.payload)).toEqual([{ id: 'gopro', on: true }]);
  });

  it('ignores card state from a process that does not own the camera', async () => {
    const t = setup([gopro]);
    await t.obsUp();
    t.cameraUp('gopro', { supported: true, recording: false });
    t.bus.publish({
      type: 'camera.driver.state',
      payload: { id: 'gopro', status: 'streaming', controls: [], card: { supported: true, recording: true } },
      source: 'driver:camera-other',
    });
    expect(t.cam('gopro').card).toBe('ready');
  });

  it('goes offline when OBS disconnects', async () => {
    const t = setup([wide]);
    await t.obsUp();
    t.bus.publish({ type: 'obs.connection', payload: { connected: false }, source: 'obs' });
    expect(t.last()).toMatchObject({ output: 'stopped', detail: 'OBS is not connected' });
    expect(t.cam('wide').iso).toBe('offline');
  });
});

describe('RecordingService — start and stop', () => {
  it('starts and stops OBS recording on command', async () => {
    const t = setup([wide]);
    await t.obsUp();
    t.bus.publish({ type: 'recording.cmd.start', payload: {}, source: 'dashboard' });
    await t.service.idle();
    t.bus.publish({ type: 'recording.cmd.stop', payload: {}, source: 'dashboard' });
    await t.service.idle();
    expect(t.fake.calls.map(([type]) => type).filter((c) => c.endsWith('Record'))).toEqual(['StartRecord', 'StopRecord']);
  });

  it('ignores commands while OBS is disconnected', async () => {
    const t = setup([wide]);
    t.bus.publish({ type: 'recording.cmd.start', payload: {}, source: 'dashboard' });
    await t.service.idle();
    expect(t.fake.calls.map(([type]) => type)).not.toContain('StartRecord');
  });

  it('shows why OBS refused to start and keeps working', async () => {
    const t = setup([wide]);
    await t.obsUp();
    const call = t.fake.obs.call.bind(t.fake.obs);
    t.fake.obs.call = async (type, data) => {
      if (type === 'StartRecord') throw new Error('Output is already active');
      return call(type, data);
    };
    t.bus.publish({ type: 'recording.cmd.start', payload: {}, source: 'dashboard' });
    await t.service.idle();
    expect(t.last().detail).toBe('Could not start recording: Output is already active');
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTED');
    expect(t.last().output).toBe('recording');
  });
});

describe('RecordingService — disk space', () => {
  it('reports free space and warns at the low and critical thresholds', async () => {
    const t = setup([wide]);
    await t.obsUp();
    expect(t.last().disk).toEqual({ path: '/rec', freeBytes: 100 * GB, level: 'ok' });

    t.disk.free = LOW_DISK_BYTES - 1;
    t.timers.fireAll();
    await t.service.idle();
    expect(t.last().disk?.level).toBe('low');

    t.disk.free = CRITICAL_DISK_BYTES - 1;
    t.timers.fireAll();
    await t.service.idle();
    expect(t.last().disk?.level).toBe('critical');
  });

  it('estimates minutes left from how fast the files grow while recording', async () => {
    const t = setup([wide]);
    await t.obsUp();
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTED');
    t.timers.fireAll(); // first sample
    await t.service.idle();
    expect(t.last().disk?.minutesLeft).toBeUndefined();

    // 1 GB used in a minute, 99 GB left.
    t.advance(60_000);
    t.disk.free = 99 * GB;
    t.timers.fireAll();
    await t.service.idle();
    expect(t.last().disk?.minutesLeft).toBe(99);
  });

  it('polls often while recording and rarely while idle', async () => {
    const t = setup([wide]);
    await t.obsUp();
    expect(t.timers.queue.map((e) => e.ms)).toEqual([300_000]);
    await t.record('OBS_WEBSOCKET_OUTPUT_STARTED');
    t.timers.fireAll();
    await t.service.idle();
    expect(t.timers.queue.map((e) => e.ms)).toEqual([30_000]);
  });

  it('leaves out disk space when the folder is not on this computer', async () => {
    const fs: RecordingFs = { freeBytes: () => Promise.reject(new Error('ENOENT')), list: async () => [] };
    const bus = new Bus();
    const fake = fakeObs(['Wide cam']);
    const states: RecordingSession[] = [];
    bus.subscribe(['recording.state'], (e) => states.push(e.payload as RecordingSession));
    const service = new RecordingService({ bus, obs: fake.obs, cameras: [wide], fs, timer: new Timers(), log: () => {} });
    service.start();
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    await service.idle();
    expect(states.at(-1)?.disk).toBeUndefined();
    expect(states.at(-1)?.cameras[0]?.iso).toBe('ready');
  });
});
