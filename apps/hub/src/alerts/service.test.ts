import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert, AlertShow, Envelope, GoalInput, GoalState } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { FakeTimer, settle } from '../testing/timer';
import { emptyAlertsFile, loadAlertsFile, type AlertsFile } from './config';
import { ALERT_GAP_MS, AlertService, RESTART_GRACE_MS } from './service';

let bus: Bus;
let timer: FakeTimer;
let events: Envelope[];
let saved: AlertsFile[];
let clock: number;
let service: AlertService;

const alert = (id: string, over: Partial<Alert> = {}): Alert => ({
  id,
  kind: 'sub',
  platform: 'twitch',
  user: { id: `u-${id}`, name: `User ${id}` },
  at: 1,
  ...over,
});

const make = (file: AlertsFile = emptyAlertsFile()) => {
  service = new AlertService({ bus, file, save: async (f) => void saved.push(f), timer, now: () => clock, log: () => {} });
  service.start();
};

beforeEach(() => {
  bus = new Bus();
  timer = new FakeTimer();
  events = [];
  saved = [];
  clock = 1_000_000;
  bus.subscribe(['alert.', 'goal.state'], (e) => events.push(e));
});

const send = (type: string, payload: unknown) => {
  const r = bus.publish({ type, payload, source: 'test' });
  if (!r.ok) throw new Error(r.error);
};
const shows = () => events.filter((e) => e.type === 'alert.show').map((e) => e.payload as AlertShow);
const hides = () => events.filter((e) => e.type === 'alert.hide').map((e) => (e.payload as { id: string }).id);
const goals = () => (events.filter((e) => e.type === 'goal.state').at(-1)!.payload as { goals: GoalState[] }).goals;
const goal = (over: Partial<GoalInput> = {}): GoalInput => ({
  id: 'g',
  label: 'Goal',
  metric: 'subs',
  scope: 'stream',
  target: 10,
  platforms: ['twitch', 'youtube'],
  ...over,
});

describe('AlertService queue', () => {
  it('plays one alert at a time with the rendered text, then the next after a gap', () => {
    make();
    send('alert.event', alert('a', { kind: 'follow' }));
    send('alert.event', alert('b', { kind: 'cheer', amount: 100 }));
    expect(shows()).toHaveLength(1);
    expect(shows()[0]).toMatchObject({ text: 'User a just followed!', sound: 'pop', durationMs: 5000 });
    timer.fire(5000);
    expect(hides()).toEqual(['a']);
    expect(shows()).toHaveLength(1);
    timer.fire(ALERT_GAP_MS);
    expect(shows()[1]).toMatchObject({ text: 'User b cheered 100 bits!', sound: 'coin' });
  });

  it('drops duplicate deliveries and repeat follows from the same viewer', () => {
    make();
    send('alert.event', alert('a', { kind: 'follow', user: { id: '7', name: 'Ada' } }));
    send('alert.event', alert('a', { kind: 'follow', user: { id: '7', name: 'Ada' } }));
    send('alert.event', alert('b', { kind: 'follow', user: { id: '7', name: 'Ada' } }));
    const recent = events.filter((e) => e.type === 'alert.recent').at(-1)!.payload as { alerts: Alert[]; queued: number };
    expect(recent.alerts.map((a) => a.id)).toEqual(['a']);
    expect(recent.queued).toBe(0);
  });

  it('skips kinds that are off and alerts below the minimum, but still lists them', () => {
    make();
    send('alert.cmd.setKind', { kind: 'follow', enabled: false });
    send('alert.cmd.setKind', { kind: 'cheer', minAmount: 100 });
    send('alert.event', alert('a', { kind: 'follow' }));
    send('alert.event', alert('b', { kind: 'cheer', amount: 99 }));
    expect(shows()).toHaveLength(0);
    const recent = events.filter((e) => e.type === 'alert.recent').at(-1)!.payload as { alerts: Alert[] };
    expect(recent.alerts).toHaveLength(2);
  });

  it('holds alerts while paused and plays them when resumed', () => {
    make();
    send('alert.cmd.pause', { paused: true });
    send('alert.event', alert('a'));
    expect(shows()).toHaveLength(0);
    send('alert.cmd.pause', { paused: false });
    expect(shows().map((s) => s.alert.id)).toEqual(['a']);
  });

  it('skip hides the alert on screen at once', () => {
    make();
    send('alert.event', alert('a'));
    send('alert.event', alert('b'));
    send('alert.cmd.skip', {});
    expect(hides()).toEqual(['a']);
    timer.fire(ALERT_GAP_MS);
    expect(shows().map((s) => s.alert.id)).toEqual(['a', 'b']);
  });

  it('test alerts play even when the kind is off, and never count toward goals', () => {
    make();
    send('goal.cmd.save', goal({ metric: 'tips', currency: 'USD' }));
    send('alert.cmd.setKind', { kind: 'tip', enabled: false });
    send('alert.cmd.test', { kind: 'tip' });
    expect(shows()[0]).toMatchObject({ text: 'Test Viewer tipped $5.00!', alert: { test: true } });
    expect(goals()[0]!.current).toBe(0);
  });

  it('replays an alert from the recent list', () => {
    make();
    send('alert.event', alert('a'));
    timer.fire(6000);
    timer.fire(ALERT_GAP_MS);
    send('alert.cmd.replay', { id: 'a' });
    expect(shows().map((s) => s.alert.id)).toEqual(['a', 'a']);
  });

  it('updates the template of one kind', () => {
    make();
    send('alert.cmd.setKind', { kind: 'sub', template: '{user} subbed' });
    const config = events.filter((e) => e.type === 'alert.config').at(-1)!.payload as { kinds: { sub: { template: string } } };
    expect(config.kinds.sub.template).toBe('{user} subbed');
  });
});

describe('AlertService goals', () => {
  it('counts subs, resubs and gifts this stream, from the chosen platforms only', () => {
    make();
    send('goal.cmd.save', goal({ platforms: ['twitch'] }));
    send('alert.event', alert('a'));
    send('alert.event', alert('b', { kind: 'resub', months: 3 }));
    send('alert.event', alert('c', { kind: 'giftsub', count: 5 }));
    send('alert.event', alert('d', { platform: 'youtube' }));
    expect(goals()[0]).toMatchObject({ id: 'g', current: 7, target: 10 });
  });

  it('adds tips in the goal currency only', () => {
    make();
    send('goal.cmd.save', goal({ metric: 'tips', currency: 'USD', target: 100 }));
    send('alert.event', alert('a', { kind: 'tip', platform: 'youtube', amount: 5, currency: 'USD' }));
    send('alert.event', alert('b', { kind: 'tip', platform: 'youtube', amount: 7, currency: 'EUR' }));
    expect(goals()[0]!.current).toBe(5);
  });

  it('shows the channel total from the platforms, moving with alerts until the next refresh', () => {
    make();
    send('goal.cmd.save', goal({ id: 'f', metric: 'followers', scope: 'total', target: 15000 }));
    expect(goals()[0]).toMatchObject({ current: 0, detail: 'No follower count from Twitch, YouTube yet' });
    send('platform.totals', { platform: 'twitch', followers: 1200, subs: 30 });
    send('platform.totals', { platform: 'youtube', followers: 12300, approximate: true });
    expect(goals()[0]).toMatchObject({ current: 13500, approximate: true });
    expect(goals()[0]!.detail).toBeUndefined();
    send('alert.event', alert('a', { kind: 'follow' }));
    expect(goals()[0]!.current).toBe(13501);
    send('platform.totals', { platform: 'twitch', followers: 1201 });
    expect(goals()[0]!.current).toBe(13501);
  });

  it('explains that YouTube has no member count for a total subs goal', () => {
    make();
    send('goal.cmd.save', goal({ scope: 'total' }));
    send('platform.totals', { platform: 'twitch', subs: 30 });
    send('alert.event', alert('a', { kind: 'resub', months: 2 }));
    send('alert.event', alert('b', { kind: 'giftsub', count: 3 }));
    expect(goals()[0]).toMatchObject({ current: 33, detail: 'YouTube does not share member counts' });
  });

  it('starts stream goals again when a new stream goes live, but not after a quick restart', () => {
    make();
    send('goal.cmd.save', goal());
    send('obs.stream.state', { state: 'live' });
    send('alert.event', alert('a'));
    send('obs.stream.state', { state: 'stopped' });
    clock += 60_000;
    send('obs.stream.state', { state: 'starting' });
    send('obs.stream.state', { state: 'live' });
    expect(goals()[0]!.current).toBe(1);
    send('obs.stream.state', { state: 'stopped' });
    clock += RESTART_GRACE_MS + 1;
    send('obs.stream.state', { state: 'live' });
    expect(goals()[0]!.current).toBe(0);
  });

  it('editing a goal keeps its count unless what it measures changes; reset and remove work', () => {
    make();
    send('goal.cmd.save', goal());
    send('alert.event', alert('a'));
    send('goal.cmd.save', goal({ label: 'Subs!', target: 20 }));
    expect(goals()[0]).toMatchObject({ label: 'Subs!', current: 1 });
    send('goal.cmd.save', goal({ metric: 'followers' }));
    expect(goals()[0]!.current).toBe(0);
    send('alert.event', alert('b', { kind: 'follow' }));
    send('goal.cmd.reset', { id: 'g' });
    expect(goals()[0]!.current).toBe(0);
    send('goal.cmd.remove', { id: 'g' });
    expect(goals()).toEqual([]);
  });

  it('saves counts and settings once per second, and on stop', async () => {
    make();
    send('goal.cmd.save', goal());
    send('alert.event', alert('a'));
    expect(saved).toHaveLength(0);
    timer.fire(1000);
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.goals[0]).toMatchObject({ count: 1 });
    send('alert.event', alert('b'));
    service.stop();
    await settle();
    expect(saved).toHaveLength(2);
  });
});

describe('loadAlertsFile', () => {
  it('fills in alert kinds a saved file does not have yet', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'alerts-'));
    const path = join(dir, 'alerts.json');
    const file = emptyAlertsFile();
    const partial = { ...file, config: { paused: true, kinds: { follow: { ...file.config.kinds.follow, enabled: false } } } };
    await writeFile(path, JSON.stringify(partial));
    const log = vi.fn();
    const loaded = await loadAlertsFile(path, log);
    expect(log).not.toHaveBeenCalled();
    expect(loaded.config.paused).toBe(true);
    expect(loaded.config.kinds.follow.enabled).toBe(false);
    expect(loaded.config.kinds.raid.enabled).toBe(true);
  });
});
