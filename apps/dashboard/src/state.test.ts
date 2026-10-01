import { describe, expect, it } from 'vitest';
import type { Envelope } from '@streamhub/shared';
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
    expect(apply([ev('show.feature.clear', {})])).toBe(initialState);
  });
});

describe('formatUptime', () => {
  it('formats h:mm:ss', () => {
    expect(formatUptime(0)).toBe('0:00:00');
    expect(formatUptime(3_723_000)).toBe('1:02:03');
    expect(formatUptime(-5)).toBe('0:00:00');
  });
});
