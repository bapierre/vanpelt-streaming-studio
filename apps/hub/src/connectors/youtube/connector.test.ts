import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../../bus/bus';
import { FakeTimer, settle } from '../../testing/timer';
import { YouTubeApiError, type StreamHandlers, type YouTubeApi } from './api';
import { YouTubeAuthError, type TokenSource } from './auth';
import { YouTubeConnector } from './connector';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const msg = (id: string, at = '2026-10-01T12:00:01Z', type = 'textMessageEvent') => ({
  id,
  snippet: { type, publishedAt: at, displayMessage: `msg ${id}` },
  authorDetails: { channelId: 'UC1', displayName: 'Viewer' },
});

let bus: Bus;
let timer: FakeTimer;
let events: Envelope[];
let streams: Array<{ pageToken?: string; handlers: StreamHandlers; cancelled: boolean }>;
let api: { [K in keyof YouTubeApi]: ReturnType<typeof vi.fn> };
let tokens: {
  accessToken: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  connected: () => boolean;
};
let connector: YouTubeConnector;

beforeEach(() => {
  bus = new Bus();
  timer = new FakeTimer();
  events = [];
  streams = [];
  bus.subscribe(['chat.', 'platform.status'], (e) => events.push(e));
  api = {
    findActiveChat: vi.fn(async () => ({ liveChatId: 'CHAT', title: 'Show #1' })),
    myChannelTitle: vi.fn(),
    pollChat: vi.fn(async () => ({
      nextPageToken: 'p2',
      pollingIntervalMillis: 4000,
      items: [msg('polled')],
    })),
    streamChat: vi.fn(
      (_t: string, _c: string, pageToken: string | undefined, handlers: StreamHandlers) => {
        const s = { pageToken, handlers, cancelled: false };
        streams.push(s);
        return { cancel: () => void (s.cancelled = true) };
      },
    ),
  };
  tokens = { accessToken: vi.fn(async () => 'tok'), invalidate: vi.fn(), connected: () => true };
  connector = new YouTubeConnector({
    bus,
    tokens: tokens as unknown as TokenSource & { connected(): boolean },
    api: api as unknown as YouTubeApi,
    channel: () => 'My Channel',
    timer,
    rand: () => 1,
    now: () => T0,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const statuses = () => events.filter((e) => e.type === 'platform.status').map((e) => e.payload);
const lastStatus = () => statuses().at(-1);
const ofType = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);

describe('YouTubeConnector', () => {
  it('reports disconnected when YouTube is not connected', () => {
    tokens.connected = () => false;
    connector.start();
    expect(api.findActiveChat).not.toHaveBeenCalled();
    expect(lastStatus()).toMatchObject({ platform: 'youtube', status: 'disconnected' });
  });

  it('reports offline and re-checks every minute when nothing is live', async () => {
    api.findActiveChat.mockResolvedValueOnce(null);
    connector.start();
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'offline' });
    expect(timer.has(60_000)).toBe(true);
    timer.fire(60_000);
    await settle();
    expect(api.findActiveChat).toHaveBeenCalledTimes(2);
    expect(api.streamChat).toHaveBeenCalledTimes(1);
  });

  it('streams chat, goes live, and drops duplicates and backlog', async () => {
    connector.start();
    await settle();
    expect(api.streamChat.mock.calls[0]!.slice(0, 3)).toEqual(['tok', 'CHAT', undefined]);
    streams[0]!.handlers.onResponse({
      nextPageToken: 'n1',
      items: [msg('old', '2026-10-01T11:00:00Z'), msg('a'), msg('a')],
    });
    expect(lastStatus()).toMatchObject({ status: 'live' });
    expect(ofType('chat.message')).toEqual([
      expect.objectContaining({ id: 'youtube:a', channel: 'My Channel' }),
    ]);
  });

  it('resumes from the last page token after a stream error', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onResponse({ nextPageToken: 'n1', items: [] });
    streams[0]!.handlers.onError(new YouTubeApiError('unavailable', 'other'));
    timer.fire(1000);
    await settle();
    expect(streams[1]!.pageToken).toBe('n1');
  });

  it('falls back to polling after repeated stream failures', async () => {
    connector.start();
    await settle();
    for (let i = 0; i < 3; i++) {
      streams.at(-1)!.handlers.onError(new YouTubeApiError('unavailable', 'other'));
      timer.fire(timer.queue[0]!.ms);
      await settle();
    }
    expect(api.pollChat).toHaveBeenCalledTimes(1);
    expect(ofType('chat.message')).toEqual([expect.objectContaining({ id: 'youtube:polled' })]);
    expect(timer.has(4000)).toBe(true);
    timer.fire(4000);
    await settle();
    expect(api.pollChat.mock.calls[1]![2]).toBe('p2');
  });

  it('goes offline when the chat ends and looks for the next broadcast', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onResponse({
      items: [msg('end', '2026-10-01T12:00:02Z', 'chatEndedEvent')],
    });
    expect(streams[0]!.cancelled).toBe(true);
    expect(lastStatus()).toMatchObject({ status: 'offline' });
    expect(timer.has(60_000)).toBe(true);
  });

  it('treats an ended-chat error and offlineAt as the end of the broadcast', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onError(new YouTubeApiError('liveChatEnded', 'ended'));
    expect(lastStatus()).toMatchObject({ status: 'offline' });
    timer.fire(60_000);
    await settle();
    streams[1]!.handlers.onResponse({ offlineAt: '2026-10-01T13:00:00Z', items: [] });
    expect(streams[1]!.cancelled).toBe(true);
    expect(lastStatus()).toMatchObject({ status: 'offline' });
  });

  it('invalidates the token on an auth error and retries', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onError(new YouTubeApiError('401', 'auth'));
    expect(tokens.invalidate).toHaveBeenCalled();
    timer.fire(1000);
    await settle();
    expect(streams).toHaveLength(2);
  });

  it('stops with a reconnect message when the sign-in is gone', async () => {
    tokens.accessToken.mockRejectedValue(
      new YouTubeAuthError('YouTube sign-in expired. Reconnect YouTube on the Connections page.'),
    );
    connector.start();
    await settle();
    expect(lastStatus()).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('Reconnect YouTube'),
    });
    expect(timer.queue).toEqual([]);
  });

  it('publishes best-effort deletions and ban clears', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onResponse({
      items: [
        { id: 'gone', snippet: { type: 'tombstone' } },
        {
          id: 'ban',
          snippet: {
            type: 'userBannedEvent',
            userBannedDetails: { bannedUserDetails: { channelId: 'UCbad' } },
          },
        },
      ],
    });
    expect(ofType('chat.deleted')).toEqual([{ id: 'youtube:gone' }]);
    expect(ofType('chat.cleared')).toEqual([{ platform: 'youtube', authorId: 'UCbad' }]);
  });

  it('stop cancels the stream and ignores late responses', async () => {
    connector.start();
    await settle();
    await connector.stop();
    expect(streams[0]!.cancelled).toBe(true);
    streams[0]!.handlers.onResponse({ items: [msg('late')] });
    expect(ofType('chat.message')).toEqual([]);
    expect(lastStatus()).toMatchObject({ status: 'disconnected' });
  });
});

describe('YouTubeConnector hardening', () => {
  it('survives a response that makes the bus or normalizer throw', async () => {
    connector.start();
    await settle();
    const spy = vi.spyOn(bus, 'publish').mockImplementation(() => {
      throw new Error('bus down');
    });
    expect(() => streams[0]!.handlers.onResponse({ items: [msg('boom')] })).not.toThrow();
    expect(() => streams[0]!.handlers.onResponse({ items: [null as never] })).not.toThrow();
    spy.mockRestore();
    expect(console.warn).toHaveBeenCalledWith(
      '[youtube] publish of chat.message failed:',
      'bus down',
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[youtube] stream response failed:',
      expect.any(String),
    );
  });

  it('survives the bus throwing while handling stream errors, ends and timers', async () => {
    connector.start();
    await settle();
    vi.spyOn(bus, 'publish').mockImplementation(() => {
      throw new Error('bus down');
    });
    expect(() =>
      streams[0]!.handlers.onError(new YouTubeApiError('unavailable', 'other')),
    ).not.toThrow();
    expect(() => streams[0]!.handlers.onEnd()).not.toThrow();
    expect(() => timer.fire(1000)).not.toThrow();
    await settle();
    expect(console.warn).toHaveBeenCalledWith(
      '[youtube] publish of platform.status failed:',
      'bus down',
    );
  });

  it('treats a synchronous streamChat throw as a stream error with backoff and failure count', async () => {
    api.streamChat.mockImplementation(() => {
      throw new Error('setup boom');
    });
    connector.start();
    await settle();
    expect(timer.has(1000)).toBe(true);
    for (let i = 0; i < 2; i++) {
      timer.fire(timer.queue[0]!.ms);
      await settle();
    }
    expect(api.streamChat).toHaveBeenCalledTimes(3);
    timer.fire(timer.queue[0]!.ms);
    await settle();
    expect(api.pollChat).toHaveBeenCalledTimes(1);
  });

  it('cancels the stream when it reports an error or ends', async () => {
    connector.start();
    await settle();
    streams[0]!.handlers.onError(new YouTubeApiError('unavailable', 'other'));
    expect(streams[0]!.cancelled).toBe(true);
    timer.fire(1000);
    await settle();
    streams[1]!.handlers.onEnd();
    expect(streams[1]!.cancelled).toBe(true);
    expect(timer.queue).toHaveLength(1);
  });

  it('start is idempotent: a second start leaves exactly one active stream', async () => {
    connector.start();
    await settle();
    connector.start();
    await settle();
    expect(streams).toHaveLength(2);
    expect(streams[0]!.cancelled).toBe(true);
    expect(streams.filter((s) => !s.cancelled)).toHaveLength(1);
    expect(statuses().filter((s) => (s as { status: string }).status === 'disconnected')).toEqual(
      [],
    );
  });

  it('reports a non-API failure as an error status and retries with backoff', async () => {
    api.findActiveChat.mockRejectedValueOnce(new TypeError('fetch failed'));
    connector.start();
    await settle();
    expect(lastStatus()).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('fetch failed'),
    });
    expect(timer.has(1000)).toBe(true);
  });
});
