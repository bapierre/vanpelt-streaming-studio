import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import type { ObsCalls } from '../cameras/obs-side';
import type { Timer } from '../util/timer';
import { PreviewService, type PreviewOptions } from './previews';

class FakeObs implements ObsCalls {
  calls: Array<[string, (object | undefined)]> = [];
  failing = new Set<string>();
  hanging = new Set<string>();
  version = { supportedImageFormats: ['png', 'jpg'] };
  private resolvers: Array<() => void> = [];

  async call(type: string, data?: object) {
    this.calls.push([type, data]);
    if (this.hanging.has(type)) return new Promise<unknown>((resolve) => this.resolvers.push(() => resolve({ imageData: 'WFla' })));
    if (this.failing.has(type)) throw new Error(`${type} failed`);
    if (type === 'GetVersion') return this.version;
    return { imageData: 'QUJD' };
  }

  /** Lets a hanging call answer; the service must cope whenever it settles. */
  release() {
    this.resolvers.splice(0).forEach((resolve) => resolve());
  }
}

class FakeTimer implements Timer {
  queue: Array<{ fn: () => void; ms: number }> = [];
  set(fn: () => void, ms: number) {
    const entry = { fn, ms };
    this.queue.push(entry);
    return entry;
  }
  clear(handle: unknown) {
    this.queue = this.queue.filter((e) => e !== handle);
  }
}

let bus: Bus;
let obs: FakeObs;
let timer: FakeTimer;
let t: number;
let events: Envelope[];
let logs: string[];
let service: PreviewService;

beforeEach(() => {
  bus = new Bus();
  obs = new FakeObs();
  timer = new FakeTimer();
  t = 100_000;
  events = [];
  logs = [];
  bus.subscribe(['obs.scene.preview'], (e) => events.push(e));
  const opts: PreviewOptions = { bus, obs, timer, now: () => t, log: (m) => logs.push(m) };
  service = new PreviewService(opts);
  service.start();
});

afterEach(() => {
  service.stop();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const publish = (type: string, payload: unknown) => bus.publish({ type, payload, source: 'test' });

const connect = async () => {
  publish('obs.connection', { connected: true });
  publish('obs.scenes.list', { scenes: ['Show', 'Screen', 'Close'], current: 'Screen' });
  await settle();
};

const watch = () => publish('obs.cmd.previews.watch', {});

type Shot = { sourceName: string; imageFormat: string; imageWidth: number; imageHeight: number };
const shots = (): Shot[] =>
  obs.calls.filter(([type]) => type === 'GetSourceScreenshot').map(([, d]) => d as Shot);
const names = () => shots().map((s) => s.sourceName);

/** Runs pending timers in order as time flows, like a real clock, until `ms` have passed. */
const advance = async (ms: number) => {
  const until = t + ms;
  while (timer.queue.length > 0) {
    const entry = timer.queue[0]!;
    if (t + entry.ms > until) break;
    timer.queue.shift();
    t += entry.ms;
    entry.fn();
    await settle();
  }
};

describe('PreviewService', () => {
  it('captures the program scene about once a second and the others round-robin every ~4 s', async () => {
    await connect();
    watch();
    await advance(4000);
    await advance(4500);
    expect(names().filter((n) => n === 'Screen')).toHaveLength(9);
    expect(names().filter((n) => n === 'Show')).toHaveLength(2);
    expect(names().filter((n) => n === 'Close')).toHaveLength(1);
    expect(names().slice(0, 2)).toEqual(['Screen', 'Show']);
    for (const shot of shots()) {
      expect(shot.imageFormat).toBe('jpg');
      expect(shot.imageWidth).toBe(320);
      expect(shot.imageHeight).toBe(180);
    }
    expect(events.map((e) => (e.payload as { scene: string; image: string }).scene)).toEqual(names());
    expect(events[0]?.payload).toMatchObject({ scene: 'Screen', image: 'data:image/jpeg;base64,QUJD' });
  });

  it('stops about 12 s after the last lease, and resumes on a new one', async () => {
    await connect();
    watch();
    await advance(1000);
    expect(shots()).toHaveLength(3);
    await advance(20_000); // the lease runs out on the way
    const expired = shots().length;
    expect(expired).toBeGreaterThan(3);
    await advance(30_000);
    expect(shots()).toHaveLength(expired); // nothing captured with no lease
    expect(timer.queue).toHaveLength(0);
    watch();
    await advance(1000);
    expect(shots().length).toBeGreaterThan(expired);
  });

  it('never has two captures in flight', async () => {
    await connect();
    obs.hanging.add('GetSourceScreenshot');
    watch();
    await advance(5000);
    expect(shots()).toHaveLength(1);
    expect(timer.queue).toHaveLength(0); // nothing scheduled behind a hung request
    obs.hanging.delete('GetSourceScreenshot');
    obs.release();
    await settle();
    expect(timer.queue).toHaveLength(1); // the round-robin resumes
    await advance(2000);
    expect(shots().length).toBeGreaterThanOrEqual(3);
  });

  it('skips failed captures, logs once per streak, and recovers without a restart', async () => {
    await connect();
    obs.failing.add('GetSourceScreenshot');
    watch();
    await advance(3500);
    expect(shots().length).toBeGreaterThanOrEqual(3); // attempts still spend their cadence slots
    expect(events).toHaveLength(0);
    expect(logs).toHaveLength(1);
    obs.failing.delete('GetSourceScreenshot');
    await advance(4000);
    expect(events.length).toBeGreaterThan(0);
    expect(logs).toHaveLength(1); // successes stay quiet
    obs.failing.add('GetSourceScreenshot');
    await advance(2500);
    expect(logs).toHaveLength(2); // a new streak speaks again
  });

  it('prefers jpg when OBS supports it', async () => {
    await connect();
    watch();
    await advance(0);
    expect(shots()[0]).toMatchObject({ sourceName: 'Screen', imageFormat: 'jpg', imageWidth: 320, imageHeight: 180 });
    expect((events[0]?.payload as { image: string }).image).toBe('data:image/jpeg;base64,QUJD');
  });

  it('falls back to png when OBS lists no jpg', async () => {
    obs.version.supportedImageFormats = ['png', 'webp'];
    await connect();
    watch();
    await advance(0);
    expect(shots()[0]).toMatchObject({ imageFormat: 'png' });
    expect((events[0]?.payload as { image: string }).image).toBe('data:image/png;base64,QUJD');
  });

  it('publishes previews without retaining or historizing them', async () => {
    await connect();
    watch();
    await advance(2000);
    expect(events.length).toBeGreaterThan(0);
    expect(bus.retainedFor(['obs.']).map((e) => e.type)).not.toContain('obs.scene.preview');
    expect(bus.retainedFor(['obs.scene.preview'])).toHaveLength(0);
    expect(bus.history('obs.scene.preview', 10)).toHaveLength(0);
    expect(bus.retainedFor(['obs.cmd.'])).toHaveLength(0); // the lease is not retained either
  });

  it('captures nothing while OBS is away, and resumes when it returns', async () => {
    publish('obs.scenes.list', { scenes: ['Show', 'Screen', 'Close'], current: 'Screen' });
    watch();
    await advance(5000);
    expect(shots()).toHaveLength(0);
    publish('obs.connection', { connected: true });
    await settle();
    await advance(1000);
    expect(shots().length).toBeGreaterThan(0);
    publish('obs.connection', { connected: false });
    expect(timer.queue).toHaveLength(0);
    await advance(10_000);
    const away = shots().length;
    publish('obs.connection', { connected: true });
    await settle();
    await advance(1000);
    expect(shots().length).toBeGreaterThan(away);
  });

  it('captures the new program scene at once after a cut', async () => {
    await connect();
    watch();
    await advance(1000);
    expect(names()).toEqual(['Screen', 'Show', 'Screen']);
    publish('obs.scene.changed', { scene: 'Close' });
    await advance(0);
    expect(names()[3]).toBe('Close');
  });

  it('stops cleanly with stop()', async () => {
    await connect();
    watch();
    await advance(1000);
    expect(timer.queue).toHaveLength(1);
    service.stop();
    expect(timer.queue).toHaveLength(0);
    await advance(5000);
    const at = shots().length;
    watch(); // a late lease must not restart a stopped service
    await advance(5000);
    expect(shots()).toHaveLength(at);
  });
});
