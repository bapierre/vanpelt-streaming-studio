import { describe, expect, it } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { chatMessage } from '@streamhub/shared/testing';
import { formatUptime, initialState, reduce, type DashboardState } from './state';

let seq = 0;
const ev = (type: string, payload: unknown): Envelope => ({
  id: String(seq++).padStart(26, '0'),
  type,
  ts: 0,
  source: 'obs',
  payload,
});
const apply = (events: Envelope[], start: DashboardState = initialState) =>
  events.reduce((s, event) => reduce(s, { kind: 'event', event }), start);

describe('reduce', () => {
  it('tracks hub connection and resets on disconnect', () => {
    const live = apply([ev('obs.connection', { connected: true })], reduce(initialState, { kind: 'hub', connected: true }));
    expect(live.hubConnected).toBe(true);
    expect(live.obs.connected).toBe(true);
    const lost = reduce(live, { kind: 'hub', connected: false });
    expect(lost).toEqual(initialState);
  });

  it('later scene change wins over retained list', () => {
    const name = '🎬 "Main" Cam';
    const s = apply([
      ev('obs.scenes.list', { scenes: ['Starting', name], current: 'Starting' }),
      ev('obs.scene.changed', { scene: name }),
    ]);
    expect(s.scenes).toEqual(['Starting', name]);
    expect(s.currentScene).toBe(name);
  });

  it('keeps OBS detail when disconnected', () => {
    const s = apply([ev('obs.connection', { connected: false, detail: 'Authentication failed.' })]);
    expect(s.obs).toEqual({ connected: false, detail: 'Authentication failed.' });
  });

  it('tracks stream state and platform statuses', () => {
    const s = apply([
      ev('obs.stream.state', { state: 'live', startedAt: 5 }),
      ev('platform.status', { platform: 'kick', status: 'error', detail: 'relay unreachable' }),
    ]);
    expect(s.stream).toEqual({ state: 'live', startedAt: 5 });
    expect(s.platforms.kick).toEqual({ status: 'error', detail: 'relay unreachable' });
  });

  it('ignores unrelated events', () => {
    expect(apply([ev('module.demo.ping', {})])).toBe(initialState);
  });
});

describe('formatUptime', () => {
  it('formats h:mm:ss', () => {
    expect(formatUptime(0)).toBe('0:00:00');
    expect(formatUptime(3_723_000)).toBe('1:02:03');
    expect(formatUptime(-5)).toBe('0:00:00');
  });
});

describe('chat state', () => {
  const chatEv = (id: string, extra: object = {}) => ev('chat.message', chatMessage({ id, ...extra }));

  it('appends messages once and caps the list', () => {
    const events = Array.from({ length: 305 }, (_, i) => chatEv(`twitch:${i}`));
    const s = apply([...events, chatEv('twitch:304')]);
    expect(s.chat).toHaveLength(300);
    expect(s.chat[0]!.id).toBe('twitch:5');
    expect(s.chat.at(-1)!.id).toBe('twitch:304');
  });

  it('removes deleted messages and cleared users or platforms', () => {
    const s = apply([
      chatEv('twitch:1', { author: { id: 'a', name: 'A', roles: [] } }),
      chatEv('twitch:2', { author: { id: 'b', name: 'B', roles: [] } }),
      chatEv('youtube:3', { platform: 'youtube' }),
      chatEv('twitch:4'),
      ev('chat.deleted', { id: 'twitch:4' }),
      ev('chat.cleared', { platform: 'twitch', authorId: 'a' }),
    ]);
    expect(s.chat.map((m) => m.id)).toEqual(['twitch:2', 'youtube:3']);
    expect(apply([ev('chat.cleared', { platform: 'twitch' })], s).chat.map((m) => m.id)).toEqual(['youtube:3']);
  });

  it('backfill merges without duplicates, ordered by time', () => {
    const live = apply([chatEv('twitch:2', { sentAt: 20 })]);
    const s = reduce(live, {
      kind: 'backfill',
      events: [ev('chat.message', chatMessage({ id: 'twitch:1', sentAt: 10 })), ev('chat.message', chatMessage({ id: 'twitch:2', sentAt: 20 }))],
    });
    expect(s.chat.map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
  });

  it('tracks the featured message and connection states', () => {
    const s = apply([
      ev('show.feature.set', { message: chatMessage({ id: 'twitch:9' }) }),
      ev('connections.state', { platform: 'twitch', state: 'connected', account: 'yatf' }),
    ]);
    expect(s.featuredId).toBe('twitch:9');
    expect(s.connections.twitch).toEqual({ platform: 'twitch', state: 'connected', account: 'yatf' });
    expect(apply([ev('show.feature.clear', {})], s).featuredId).toBeNull();
  });
});
