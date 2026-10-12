import { describe, expect, it, vi } from 'vitest';
import { chatMessage } from '@streamhub/shared/testing';
import { Bus } from './bus';

const scene = (name: string) => ({ type: 'obs.scene.changed', payload: { scene: name }, source: 'obs' });

describe('Bus', () => {
  it('publishes a valid event as an envelope', () => {
    const bus = new Bus(() => 1234);
    const r = bus.publish(scene('Main'));
    expect(r).toMatchObject({
      ok: true,
      event: { type: 'obs.scene.changed', ts: 1234, source: 'obs', payload: { scene: 'Main' } },
    });
    if (r.ok) expect(r.event.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('rejects invalid payloads without notifying subscribers', () => {
    const bus = new Bus();
    const handler = vi.fn();
    bus.subscribe(['*'], handler);
    const r = bus.publish({ type: 'obs.scene.changed', payload: { scene: 1 }, source: 'obs' });
    expect(r.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers by topic and stops after unsubscribe', () => {
    const bus = new Bus();
    const obs = vi.fn();
    const chat = vi.fn();
    const off = bus.subscribe(['obs.'], obs);
    bus.subscribe(['chat.message'], chat);
    bus.publish(scene('A'));
    bus.publish({ type: 'chat.message', payload: chatMessage(), source: 'connector:twitch' });
    expect(obs).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    off();
    bus.publish(scene('B'));
    expect(obs).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when one handler throws', () => {
    const bus = new Bus();
    const good = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.subscribe(['*'], () => {
      throw new Error('boom');
    });
    bus.subscribe(['*'], good);
    bus.publish(scene('A'));
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('keeps the last 200 chat messages', () => {
    const bus = new Bus();
    for (let i = 0; i < 205; i++) {
      bus.publish({ type: 'chat.message', payload: chatMessage({ id: `twitch:${i}` }), source: 't' });
    }
    const all = bus.history('chat.message', 500);
    expect(all).toHaveLength(200);
    expect((all[0]!.payload as { id: string }).id).toBe('twitch:5');
    const last = bus.history('chat.message', 2);
    expect(last.map((e) => (e.payload as { id: string }).id)).toEqual(['twitch:203', 'twitch:204']);
    expect(bus.history('obs.scene.changed', 10)).toEqual([]);
  });

  it('retains latest state per key, ordered', () => {
    const bus = new Bus();
    bus.publish({ type: 'obs.scenes.list', payload: { scenes: ['A', 'B'], current: 'A' }, source: 'obs' });
    bus.publish(scene('B'));
    bus.publish(scene('C'));
    bus.publish({ type: 'platform.status', payload: { platform: 'twitch', status: 'live' }, source: 't' });
    bus.publish({ type: 'platform.status', payload: { platform: 'kick', status: 'error' }, source: 'k' });
    bus.publish({ type: 'chat.message', payload: chatMessage(), source: 't' });

    const obs = bus.retainedFor(['obs.']);
    expect(obs.map((e) => e.type)).toEqual(['obs.scenes.list', 'obs.scene.changed']);
    expect(obs[1]!.payload).toEqual({ scene: 'C' });

    const platforms = bus.retainedFor(['platform.status']);
    expect(platforms.map((e) => (e.payload as { platform: string }).platform)).toEqual([
      'twitch',
      'kick',
    ]);
    expect(bus.retainedFor(['chat.'])).toEqual([]);
  });

  it('retains OBS settings, sources and stream destinations', () => {
    const bus = new Bus();
    bus.publish({ type: 'obs.settings', payload: { url: 'ws://a', passwordSet: false }, source: 'hub' });
    bus.publish({ type: 'obs.settings', payload: { url: 'ws://b', passwordSet: true }, source: 'hub' });
    bus.publish({ type: 'obs.sources.list', payload: { scene: 'Main', sources: [] }, source: 'obs' });
    bus.publish({ type: 'destinations.list', payload: { destinations: [], inObs: null }, source: 'hub' });
    expect(bus.retainedFor(['obs.', 'destinations.']).map((e) => [e.type, e.payload])).toEqual([
      ['obs.settings', { url: 'ws://b', passwordSet: true }],
      ['obs.sources.list', { scene: 'Main', sources: [] }],
      ['destinations.list', { destinations: [], inObs: null }],
    ]);
  });

  it('retains connection state per platform', () => {
    const bus = new Bus();
    bus.publish({ type: 'connections.state', payload: { platform: 'twitch', state: 'pending' }, source: 'hub' });
    bus.publish({ type: 'connections.state', payload: { platform: 'youtube', state: 'disconnected' }, source: 'hub' });
    bus.publish({ type: 'connections.state', payload: { platform: 'twitch', state: 'connected', account: 'yatf' }, source: 'hub' });
    const states = bus.retainedFor(['connections.']).map((e) => e.payload);
    expect(states).toEqual([
      { platform: 'youtube', state: 'disconnected' },
      { platform: 'twitch', state: 'connected', account: 'yatf' },
    ]);
  });
  it('retains camera state per camera id', () => {
    const bus = new Bus();
    const cam = (id: string, status: string) => ({
      type: 'camera.state',
      payload: { id, name: id, driver: null, status, scene: id, onAir: false, controls: [] },
      source: 'hub',
    });
    bus.publish(cam('gopro', 'connecting'));
    bus.publish(cam('sony', 'ready'));
    bus.publish(cam('gopro', 'streaming'));
    const states = bus.retainedFor(['camera.state']).map((e) => e.payload as { id: string; status: string });
    expect(states.map((s) => [s.id, s.status])).toEqual([
      ['sony', 'ready'],
      ['gopro', 'streaming'],
    ]);
  });
  it('retains the latest headsets state', () => {
    const bus = new Bus();
    const state = (plugin: boolean | null) => ({ plugin, outputs: [], sources: [], stream: {}, labels: {}, headsets: [] });
    bus.publish({ type: 'headsets.state', payload: state(null), source: 'headsets' });
    bus.publish({ type: 'headsets.state', payload: state(true), source: 'headsets' });
    expect(bus.retainedFor(['headsets.']).map((e) => e.payload)).toEqual([state(true)]);
  });
  const msg = (id: string, platform: 'twitch' | 'youtube', authorId: string) => ({
    type: 'chat.message',
    payload: chatMessage({ id, platform, author: { id: authorId, name: authorId, roles: [] } }),
    source: 't',
  });
  const ids = (bus: Bus) => bus.history('chat.message', 500).map((e) => (e.payload as { id: string }).id);

  it('removes a deleted message from chat history', () => {
    const bus = new Bus();
    bus.publish(msg('twitch:1', 'twitch', 'u1'));
    bus.publish(msg('twitch:2', 'twitch', 'u1'));
    bus.publish({ type: 'chat.deleted', payload: { id: 'twitch:1' }, source: 't' });
    expect(ids(bus)).toEqual(['twitch:2']);
  });

  it('removes one user\'s messages on a per-user clear', () => {
    const bus = new Bus();
    bus.publish(msg('twitch:1', 'twitch', 'u1'));
    bus.publish(msg('twitch:2', 'twitch', 'u2'));
    bus.publish(msg('youtube:3', 'youtube', 'u1'));
    bus.publish({ type: 'chat.cleared', payload: { platform: 'twitch', authorId: 'u1' }, source: 't' });
    expect(ids(bus)).toEqual(['twitch:2', 'youtube:3']);
  });

  it('removes a whole platform on a clear and keeps other platforms', () => {
    const bus = new Bus();
    bus.publish(msg('twitch:1', 'twitch', 'u1'));
    bus.publish(msg('youtube:2', 'youtube', 'u2'));
    bus.publish(msg('twitch:3', 'twitch', 'u2'));
    bus.publish({ type: 'chat.cleared', payload: { platform: 'twitch' }, source: 't' });
    expect(ids(bus)).toEqual(['youtube:2']);
  });
});
