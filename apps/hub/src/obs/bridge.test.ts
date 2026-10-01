import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { ObsBridge, type ObsClient, type Timer } from './bridge';

class FakeObs extends EventEmitter implements ObsClient {
  connectResults: Array<Error | null> = [];
  calls: Array<[string, object | undefined]> = [];
  responses: Record<string, unknown> = {
    GetSceneList: {
      currentProgramSceneName: 'Main Cam',
      scenes: [
        { sceneName: 'Ending', sceneIndex: 0 },
        { sceneName: 'Main Cam', sceneIndex: 1 },
        { sceneName: 'Starting Soon', sceneIndex: 2 },
      ],
    },
    GetStreamStatus: { outputActive: false, outputDuration: 0 },
    GetSceneItemId: { sceneItemId: 7 },
  };
  failing = new Set<string>();

  async connect() {
    const next = this.connectResults.shift() ?? null;
    if (next) throw next;
  }
  async disconnect() {}
  async call(type: string, data?: object) {
    this.calls.push([type, data]);
    if (this.failing.has(type)) throw new Error(`${type} failed`);
    return this.responses[type] ?? {};
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
  runNext() {
    this.queue.shift()?.fn();
  }
}

const flush = () => new Promise((r) => setImmediate(r));

let bus: Bus;
let obs: FakeObs;
let timer: FakeTimer;
let events: Envelope[];
let bridge: ObsBridge;

beforeEach(() => {
  bus = new Bus();
  obs = new FakeObs();
  timer = new FakeTimer();
  events = [];
  bus.subscribe(['obs.'], (e) => {
    if (!e.type.startsWith('obs.cmd.')) events.push(e);
  });
  bridge = new ObsBridge({
    bus,
    client: obs,
    url: 'ws://127.0.0.1:4455',
    password: 'pw',
    timer,
    rand: () => 1,
    now: () => 100_000,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await bridge.stop();
});

const payloads = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);

describe('ObsBridge', () => {
  it('publishes connection, scenes in UI order and stream state on connect', async () => {
    bridge.start();
    await flush();
    expect(payloads('obs.connection')).toEqual([{ connected: true }]);
    expect(payloads('obs.scenes.list')).toEqual([
      { scenes: ['Starting Soon', 'Main Cam', 'Ending'], current: 'Main Cam' },
    ]);
    expect(payloads('obs.stream.state')).toEqual([{ state: 'stopped' }]);
  });

  it('reports an already-running stream with its start time', async () => {
    obs.responses.GetStreamStatus = { outputActive: true, outputDuration: 60_000 };
    bridge.start();
    await flush();
    expect(payloads('obs.stream.state')).toEqual([{ state: 'live', startedAt: 40_000 }]);
  });

  it('retries with backoff when OBS is down', async () => {
    obs.connectResults = [new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED')];
    bridge.start();
    await flush();
    expect(payloads('obs.connection')).toEqual([
      { connected: false, detail: 'connect ECONNREFUSED' },
    ]);
    expect(timer.queue.map((e) => e.ms)).toEqual([1000]);

    timer.runNext();
    await flush();
    expect(timer.queue.map((e) => e.ms)).toEqual([2000]);

    timer.runNext();
    await flush();
    expect(payloads('obs.connection').at(-1)).toEqual({ connected: true });
    expect(timer.queue).toEqual([]);
  });

  it('reports auth failure detail and keeps retrying', async () => {
    obs.connectResults = [new Error('Authentication failed.')];
    bridge.start();
    await flush();
    expect(payloads('obs.connection')).toEqual([
      { connected: false, detail: 'Authentication failed.' },
    ]);
    expect(timer.queue).toHaveLength(1);
  });

  it('reconnects once after OBS closes the connection', async () => {
    bridge.start();
    await flush();
    obs.emit('ConnectionClosed', new Error('socket closed'));
    obs.emit('ConnectionClosed', new Error('socket closed'));
    expect(payloads('obs.connection').at(-1)).toEqual({ connected: false, detail: 'socket closed' });
    expect(timer.queue).toHaveLength(1);
  });

  it('forwards OBS scene and stream events', async () => {
    bridge.start();
    await flush();
    obs.emit('CurrentProgramSceneChanged', { sceneName: 'Ending' });
    obs.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
    expect(payloads('obs.scene.changed')).toEqual([{ scene: 'Ending' }]);
    expect(payloads('obs.stream.state').at(-1)).toEqual({ state: 'live', startedAt: 100_000 });
  });

  it('refreshes the scene list when scenes change', async () => {
    bridge.start();
    await flush();
    obs.emit('SceneListChanged', { scenes: [] });
    await flush();
    expect(payloads('obs.scenes.list')).toHaveLength(2);
  });

  it('passes scene names verbatim', async () => {
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.setScene', payload: { scene: '🎬 "Main" Cam' }, source: 'dashboard' });
    await flush();
    expect(obs.calls).toContainEqual(['SetCurrentProgramScene', { sceneName: '🎬 "Main" Cam' }]);
  });

  it('starts and stops the stream', async () => {
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.startStream', payload: {}, source: 'dashboard' });
    bus.publish({ type: 'obs.cmd.stopStream', payload: {}, source: 'dashboard' });
    await flush();
    expect(obs.calls.map(([t]) => t)).toEqual(
      expect.arrayContaining(['StartStream', 'StopStream']),
    );
  });

  it('toggles source visibility by scene item id', async () => {
    bridge.start();
    await flush();
    bus.publish({
      type: 'obs.cmd.setSourceVisible',
      payload: { scene: 'Main Cam', source: 'Webcam', visible: false },
      source: 'dashboard',
    });
    await flush();
    expect(obs.calls).toContainEqual(['GetSceneItemId', { sceneName: 'Main Cam', sourceName: 'Webcam' }]);
    expect(obs.calls).toContainEqual([
      'SetSceneItemEnabled',
      { sceneName: 'Main Cam', sceneItemId: 7, sceneItemEnabled: false },
    ]);
  });

  it('ignores commands while disconnected', async () => {
    obs.connectResults = [new Error('down')];
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.startStream', payload: {}, source: 'dashboard' });
    await flush();
    expect(obs.calls.map(([t]) => t)).not.toContain('StartStream');
  });

  it('survives OBS rejecting a command', async () => {
    obs.failing.add('StartStream');
    bridge.start();
    await flush();
    bus.publish({ type: 'obs.cmd.startStream', payload: {}, source: 'dashboard' });
    await flush();
    bus.publish({ type: 'obs.cmd.setScene', payload: { scene: 'Ending' }, source: 'dashboard' });
    await flush();
    expect(obs.calls).toContainEqual(['SetCurrentProgramScene', { sceneName: 'Ending' }]);
  });
});
