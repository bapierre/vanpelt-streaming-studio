import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayload, StreamDestination } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import type { Secrets } from '../secrets/store';
import { DestinationsService } from './service';

class MemoryStore {
  constructor(public data: Secrets = {}) {}
  failWrites = false;
  get(): Secrets {
    return structuredClone(this.data);
  }
  async update(fn: (s: Secrets) => Secrets) {
    if (this.failWrites) throw new Error('disk full');
    this.data = fn(structuredClone(this.data));
  }
}

class FakeObs {
  connected = true;
  calls: Array<[string, object | undefined]> = [];
  responses: Record<string, unknown> = {
    GetStreamStatus: { outputActive: false },
    GetStreamServiceSettings: { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: '', key: '' } },
  };
  failing = new Map<string, Error>();
  isConnected() {
    return this.connected;
  }
  async call(type: string, data?: object) {
    if (!this.connected) throw new Error('OBS is not connected');
    this.calls.push([type, data]);
    const err = this.failing.get(type);
    if (err) throw err;
    return this.responses[type] ?? {};
  }
}

const YT: StreamDestination = { id: 'youtube', label: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', key: 'yt-key-123' };
const TW: StreamDestination = { id: 'twitch', label: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'live_tw_456' };

let bus: Bus;
let store: MemoryStore;
let obs: FakeObs;
let svc: DestinationsService;
let lists: Array<EventPayload<'destinations.list'>>;

beforeEach(() => {
  bus = new Bus();
  store = new MemoryStore({ destinations: [YT] });
  obs = new FakeObs();
  lists = [];
  bus.subscribe(['destinations.list'], (e) => lists.push(e.payload as EventPayload<'destinations.list'>));
  svc = new DestinationsService({ bus, store, obs });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const cmd = async (type: string, payload: object) => {
  const res = bus.publish({ type, payload, source: 'dashboard' });
  expect(res.ok).toBe(true);
  await svc.idle();
};
const last = () => lists.at(-1)!;

describe('DestinationsService', () => {
  it('publishes the saved destinations on start', () => {
    svc.start();
    expect(lists).toEqual([{ destinations: [YT], inObs: null }]);
  });

  it('inserts new destinations and replaces by id, persisting each change', async () => {
    svc.start();
    await cmd('destinations.cmd.save', TW);
    expect(last().destinations).toEqual([YT, TW]);
    const renamed = { ...YT, label: 'YouTube main' };
    await cmd('destinations.cmd.save', renamed);
    expect(last().destinations).toEqual([renamed, TW]);
    expect(store.data.destinations).toEqual([renamed, TW]);
  });

  it('removes a destination and clears inObs if OBS was using it', async () => {
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    expect(last().inObs).toBe('youtube');
    await cmd('destinations.cmd.remove', { id: 'youtube' });
    expect(last()).toEqual({ destinations: [], inObs: null });
    expect(store.data.destinations).toEqual([]);
  });

  it('writes the destination into OBS as a custom RTMP server', async () => {
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    expect(obs.calls).toContainEqual([
      'SetStreamServiceSettings',
      { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: YT.server, key: YT.key } },
    ]);
    expect(last()).toEqual({ destinations: [YT], inObs: 'youtube' });
  });

  it('refuses to switch while OBS is streaming', async () => {
    obs.responses.GetStreamStatus = { outputActive: true };
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    expect(obs.calls.map(([t]) => t)).not.toContain('SetStreamServiceSettings');
    expect(last().inObs).toBeNull();
    expect(last().detail).toMatch(/stop the stream/i);
  });

  it('refuses to switch while OBS is disconnected', async () => {
    obs.connected = false;
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    expect(last().inObs).toBeNull();
    expect(last().detail).toBe('OBS is not connected.');
  });

  it('clears detail after the next success', async () => {
    obs.connected = false;
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    obs.connected = true;
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    expect(last()).toEqual({ destinations: [YT], inObs: 'youtube' });
  });

  it('works out which destination OBS uses whenever OBS connects', async () => {
    store.data.destinations = [YT, TW];
    obs.responses.GetStreamServiceSettings = {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: TW.server, key: TW.key },
    };
    svc.start();
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    await svc.idle();
    expect(last().inObs).toBe('twitch');

    obs.responses.GetStreamServiceSettings = {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: TW.server, key: 'some-other-key' },
    };
    bus.publish({ type: 'obs.connection', payload: { connected: false }, source: 'obs' });
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    await svc.idle();
    expect(last().inObs).toBeNull();
    expect(obs.calls.filter(([t]) => t === 'GetStreamServiceSettings')).toHaveLength(2);
  });

  it('forgets inObs when the destination OBS uses gets a new key', async () => {
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    await cmd('destinations.cmd.save', { ...YT, label: 'Renamed' });
    expect(last().inObs).toBe('youtube');
    await cmd('destinations.cmd.save', { ...YT, key: 'rotated-key' });
    expect(last().inObs).toBeNull();
  });

  it('never puts a stream key into detail or logs', async () => {
    obs.failing.set('SetStreamServiceSettings', new Error(`rejected key ${YT.key}`));
    svc.start();
    await cmd('destinations.cmd.useInObs', { id: 'youtube' });
    expect(last().detail).toBeDefined();
    expect(last().detail).not.toContain(YT.key);
    expect(last().inObs).toBeNull();

    store.failWrites = true;
    await cmd('destinations.cmd.save', TW);
    expect(last().detail).toContain('disk full');
    expect(last().destinations).toEqual([YT]);

    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).not.toContain(YT.key);
    expect(logged).not.toContain(TW.key);
  });
});
