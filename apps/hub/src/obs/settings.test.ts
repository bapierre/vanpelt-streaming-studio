import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import type { Secrets } from '../secrets/store';
import { loadObsSettings, ObsSettingsService } from './settings';

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

const ENV = { url: 'ws://127.0.0.1:4455', password: 'env-pw' };

let bus: Bus;
let store: MemoryStore;
let configure: ReturnType<typeof vi.fn<(url: string, password: string) => Promise<void>>>;
let events: Envelope[];

beforeEach(() => {
  bus = new Bus();
  store = new MemoryStore();
  configure = vi.fn<(url: string, password: string) => Promise<void>>(async () => {});
  events = [];
  bus.subscribe(['obs.settings'], (e) => events.push(e));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function startService() {
  const svc = new ObsSettingsService({ bus, store, bridge: { configure }, initial: loadObsSettings(store, ENV) });
  svc.start();
  return svc;
}

const setObs = (payload: object) => bus.publish({ type: 'connections.cmd.setObs', payload, source: 'dashboard' });
const settings = () => events.map((e) => e.payload);

describe('loadObsSettings', () => {
  it('uses .env until settings are saved, then the saved ones', () => {
    expect(loadObsSettings(store, ENV)).toEqual(ENV);
    store.data.obs = { url: 'ws://10.0.0.2:4455', password: '' };
    expect(loadObsSettings(store, ENV)).toEqual({ url: 'ws://10.0.0.2:4455', password: '' });
  });
});

describe('ObsSettingsService', () => {
  it('publishes the url and whether a password is set, never the password', () => {
    startService();
    expect(settings()).toEqual([{ url: ENV.url, passwordSet: true }]);
    expect(JSON.stringify(events)).not.toContain('env-pw');
  });

  it('keeps the saved password when the url is unchanged and none is sent', async () => {
    const svc = startService();
    setObs({ url: ENV.url });
    await svc.idle();
    expect(store.data.obs).toEqual({ url: ENV.url, password: 'env-pw' });
    expect(configure).toHaveBeenCalledWith(ENV.url, 'env-pw');
    expect(settings().at(-1)).toEqual({ url: ENV.url, passwordSet: true });
  });

  it('drops the saved password when the url changes and none is sent', async () => {
    const svc = startService();
    setObs({ url: 'ws://10.0.0.2:4455' });
    await svc.idle();
    expect(store.data.obs).toEqual({ url: 'ws://10.0.0.2:4455', password: '' });
    expect(configure).toHaveBeenCalledWith('ws://10.0.0.2:4455', '');
    expect(settings().at(-1)).toEqual({ url: 'ws://10.0.0.2:4455', passwordSet: false });
  });

  it('treats an empty password as no password', async () => {
    const svc = startService();
    setObs({ url: 'ws://127.0.0.1:4455', password: '' });
    await svc.idle();
    expect(store.data.obs).toEqual({ url: 'ws://127.0.0.1:4455', password: '' });
    expect(configure).toHaveBeenCalledWith('ws://127.0.0.1:4455', '');
    expect(settings().at(-1)).toEqual({ url: 'ws://127.0.0.1:4455', passwordSet: false });
  });

  it('replaces the password when one is sent', async () => {
    store.data.obs = { url: 'ws://a:1', password: 'old' };
    const svc = startService();
    setObs({ url: 'ws://a:1', password: 'new' });
    await svc.idle();
    expect(store.data.obs).toEqual({ url: 'ws://a:1', password: 'new' });
    expect(configure).toHaveBeenCalledWith('ws://a:1', 'new');
  });

  it('applies the settings for this session even if saving fails', async () => {
    store.failWrites = true;
    const svc = startService();
    setObs({ url: 'ws://10.0.0.2:4455', password: 'secret-pw' });
    await svc.idle();
    expect(configure).toHaveBeenCalledWith('ws://10.0.0.2:4455', 'secret-pw');
    expect(settings().at(-1)).toEqual({ url: 'ws://10.0.0.2:4455', passwordSet: true });
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).not.toContain('secret-pw');
  });

  it('never applies a command the bus rejected as invalid', async () => {
    const svc = startService();
    setObs({ url: 'not-a-url' });
    await svc.idle();
    expect(configure).not.toHaveBeenCalled();
    expect(settings()).toHaveLength(1);
  });
});
