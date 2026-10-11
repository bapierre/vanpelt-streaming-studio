import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../../bus/bus';
import { FakeTimer, settle } from '../../testing/timer';
import { XApiError, type XApi } from './api';
import { XAuthError } from './auth';
import { XConnector } from './connector';

let bus: Bus;
let timer: FakeTimer;
let events: Envelope[];
let api: { [K in keyof XApi]: ReturnType<typeof vi.fn> };
let tokens: {
  accessToken: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  connected: ReturnType<typeof vi.fn>;
  userId: ReturnType<typeof vi.fn>;
};
let onAuthLost: ReturnType<typeof vi.fn>;
let connector: XConnector;

const running = {
  broadcast: 'running',
  title: 'Show #1',
  viewers: 12,
  startedAt: 1000,
  sourceId: 'src',
};
const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);
const statuses = () => of('platform.status') as Array<{ status: string; detail?: string }>;
const lives = () => of('platform.live');

beforeEach(() => {
  bus = new Bus();
  timer = new FakeTimer();
  events = [];
  bus.subscribe(['platform.'], (e) => events.push(e));
  api = {
    me: vi.fn(),
    latestBroadcast: vi.fn(async () => running),
    ingest: vi.fn(async () => 'active'),
  };
  tokens = {
    accessToken: vi.fn(async () => 'tok'),
    invalidate: vi.fn(),
    connected: vi.fn(() => true),
    userId: vi.fn(() => '42'),
  };
  onAuthLost = vi.fn();
  connector = new XConnector({
    bus,
    tokens: tokens as never,
    api: api as unknown as XApi,
    timer,
    rand: () => 0,
    onAuthLost: onAuthLost as never,
  });
});

describe('XConnector', () => {
  it('reports disconnected and a cleared live state when not connected', () => {
    tokens.connected.mockReturnValue(false);
    connector.start();
    expect(statuses()).toEqual([
      { platform: 'x', status: 'disconnected', detail: 'Connect X in Settings → Platforms' },
    ]);
    expect(lives()).toEqual([{ platform: 'x', ingest: 'unknown', broadcast: 'none' }]);
    expect(api.latestBroadcast).not.toHaveBeenCalled();
  });

  it('publishes connecting, then live with the running broadcast, and polls every 15 s', async () => {
    connector.start();
    await settle();
    expect(statuses()).toEqual([
      { platform: 'x', status: 'connecting' },
      { platform: 'x', status: 'live', detail: 'Show #1' },
    ]);
    expect(lives()).toEqual([
      {
        platform: 'x',
        ingest: 'active',
        broadcast: 'running',
        viewers: 12,
        title: 'Show #1',
        startedAt: 1000,
      },
    ]);
    expect(api.ingest).toHaveBeenCalledWith('tok', '42', 'src');
    timer.fire(15_000);
    await settle();
    expect(api.latestBroadcast).toHaveBeenCalledTimes(2);
  });

  it('reports offline with broadcast none and polls every 30 s when there is no broadcast', async () => {
    api.latestBroadcast.mockResolvedValue(null);
    api.ingest.mockResolvedValue('inactive');
    connector.start();
    await settle();
    expect(statuses().at(-1)).toEqual({
      platform: 'x',
      status: 'offline',
      detail: 'No live broadcast right now',
    });
    expect(lives().at(-1)).toEqual({ platform: 'x', ingest: 'inactive', broadcast: 'none' });
    expect(timer.has(30_000)).toBe(true);
  });

  it('treats a scheduled broadcast as offline but keeps the fast cadence', async () => {
    api.latestBroadcast.mockResolvedValue({ broadcast: 'scheduled', title: 'Soon' });
    connector.start();
    await settle();
    expect(statuses().at(-1)).toMatchObject({
      status: 'offline',
      detail: 'Broadcast not started yet',
    });
    expect(lives().at(-1)).toMatchObject({ broadcast: 'scheduled', title: 'Soon' });
    expect(timer.has(15_000)).toBe(true);
  });

  it('stops asking for ingest for the session once X refuses the sources endpoint', async () => {
    api.ingest.mockRejectedValue(new XApiError('no access', 'unavailable'));
    connector.start();
    await settle();
    expect(lives().at(-1)).toMatchObject({ ingest: 'unknown', broadcast: 'running' });
    expect(statuses().at(-1)).toMatchObject({ status: 'live' });
    timer.fire(15_000);
    await settle();
    expect(api.ingest).toHaveBeenCalledTimes(1);
    expect(lives().at(-1)).toMatchObject({ ingest: 'unknown', broadcast: 'running' });
  });

  it('reports ingest unknown without failing the poll on a transient ingest error', async () => {
    api.ingest.mockRejectedValueOnce(new XApiError('down', 'other'));
    connector.start();
    await settle();
    expect(lives().at(-1)).toMatchObject({ ingest: 'unknown' });
    timer.fire(15_000);
    await settle();
    expect(api.ingest).toHaveBeenCalledTimes(2);
    expect(lives().at(-1)).toMatchObject({ ingest: 'active' });
  });

  it('skips ingest when the user id is not known', async () => {
    tokens.userId.mockReturnValue(undefined);
    connector.start();
    await settle();
    expect(api.ingest).not.toHaveBeenCalled();
    expect(lives().at(-1)).toMatchObject({ ingest: 'unknown' });
  });

  it('backs off for at least the rate-limit reset on 429', async () => {
    api.latestBroadcast.mockRejectedValueOnce(
      new XApiError('X rate limit reached (broadcasts)', 'rate', 120_000),
    );
    connector.start();
    await settle();
    expect(statuses().at(-1)).toEqual({
      platform: 'x',
      status: 'error',
      detail: 'X rate limit reached (broadcasts)',
    });
    expect(timer.has(120_000)).toBe(true);
    timer.fire(120_000);
    await settle();
    expect(statuses().at(-1)).toMatchObject({ status: 'live' });
  });

  it('waits at least 60 s on 429 without a reset header', async () => {
    api.latestBroadcast.mockRejectedValueOnce(new XApiError('rate', 'rate'));
    connector.start();
    await settle();
    expect(timer.has(60_000)).toBe(true);
  });

  it('retries with growing backoff on other errors', async () => {
    api.latestBroadcast.mockRejectedValue(
      new XApiError('X broadcasts request failed (503)', 'other'),
    );
    connector.start();
    await settle();
    expect(statuses().at(-1)).toMatchObject({
      status: 'error',
      detail: 'X broadcasts request failed (503)',
    });
    timer.fire(500);
    await settle();
    timer.fire(1000);
    await settle();
    expect(timer.has(2000)).toBe(true);
  });

  it('invalidates the token and retries on a 401', async () => {
    api.latestBroadcast.mockRejectedValueOnce(
      new XApiError('X rejected the sign-in (broadcasts)', 'auth'),
    );
    connector.start();
    await settle();
    expect(tokens.invalidate).toHaveBeenCalled();
    expect(statuses().at(-1)).toMatchObject({ status: 'connecting' });
    timer.fire(500);
    await settle();
    expect(statuses().at(-1)).toMatchObject({ status: 'live' });
  });

  it('explains missing Livestream API access and retries rarely on 403', async () => {
    api.latestBroadcast.mockRejectedValue(new XApiError('forbidden', 'forbidden'));
    connector.start();
    await settle();
    expect(statuses().at(-1)).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('Livestream API access'),
    });
    expect(lives().at(-1)).toMatchObject({
      broadcast: 'none',
      ingest: 'unknown',
      detail: expect.stringContaining('docs/setup/x.md'),
    });
    expect(timer.queue.map((e) => e.ms)).toEqual([600_000]);
  });

  it('stops and reports auth loss when the refresh is rejected', async () => {
    tokens.accessToken.mockRejectedValue(
      new XAuthError('X sign-in expired. Reconnect X in Settings → Platforms.'),
    );
    connector.start();
    await settle();
    expect(statuses().at(-1)).toEqual({
      platform: 'x',
      status: 'error',
      detail: 'X sign-in expired. Reconnect X in Settings → Platforms.',
    });
    expect(lives().at(-1)).toEqual({ platform: 'x', ingest: 'unknown', broadcast: 'none' });
    expect(onAuthLost).toHaveBeenCalledWith(
      'X sign-in expired. Reconnect X in Settings → Platforms.',
    );
    expect(timer.queue).toEqual([]);
  });

  it('stop cancels the poll, ignores in-flight results and clears the live state', async () => {
    let release!: (v: unknown) => void;
    api.latestBroadcast.mockReturnValueOnce(new Promise((r) => (release = r)));
    connector.start();
    await settle();
    await connector.stop();
    release(running);
    await settle();
    expect(statuses().at(-1)).toEqual({ platform: 'x', status: 'disconnected' });
    expect(lives()).toEqual([{ platform: 'x', ingest: 'unknown', broadcast: 'none' }]);
    expect(timer.queue).toEqual([]);
  });

  it('never throws out of a timer when the bus throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.subscribe(['platform.live'], () => {
      throw new Error('subscriber broke');
    });
    connector.start();
    await settle();
    expect(() => timer.fire(15_000)).not.toThrow();
  });
});
