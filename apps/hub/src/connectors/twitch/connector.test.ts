import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../../bus/bus';
import { FakeTimer, settle } from '../../testing/timer';
import type { SocketLike } from '../types';
import { TwitchConnector } from './connector';
import chatMessage from './fixtures/chat-message.json';
import messageDelete from './fixtures/message-delete.json';

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
}

const welcome = (id = 'SESSION1', keepalive = 10) => ({
  metadata: { message_id: `w-${id}`, message_type: 'session_welcome', message_timestamp: '2023-07-19T14:56:51.634234626Z' },
  payload: { session: { id, status: 'connected', connected_at: '2023-07-19T14:56:51Z', keepalive_timeout_seconds: keepalive, reconnect_url: null } },
});

let bus: Bus;
let timer: FakeTimer;
let sockets: FakeSocket[];
let events: Envelope[];
let helix: ReturnType<typeof vi.fn>;
let validate: ReturnType<typeof vi.fn>;
let tokens: { accessToken: string; refreshToken: string; userId: string; login: string } | undefined;
let connector: TwitchConnector;

beforeEach(() => {
  bus = new Bus();
  timer = new FakeTimer();
  sockets = [];
  events = [];
  tokens = { accessToken: 'a', refreshToken: 'r', userId: '1971641', login: 'streamer' };
  helix = vi.fn(async () => new Response(null, { status: 202 }));
  validate = vi.fn(async () => true);
  bus.subscribe(['chat.', 'platform.status'], (e) => events.push(e));
  connector = new TwitchConnector({
    bus,
    auth: { tokens: () => tokens, helix, validate } as never,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timer,
    rand: () => 1,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const statuses = () => events.filter((e) => e.type === 'platform.status').map((e) => e.payload);
const lastStatus = () => statuses().at(-1);
const ofType = (type: string) => events.filter((e) => e.type === type).map((e) => e.payload);

describe('TwitchConnector', () => {
  it('reports disconnected and opens nothing without tokens', () => {
    tokens = undefined;
    connector.start();
    expect(sockets).toHaveLength(0);
    expect(lastStatus()).toMatchObject({ platform: 'twitch', status: 'disconnected' });
  });

  it('subscribes to the four chat events on welcome, then goes live', async () => {
    connector.start();
    expect(sockets[0]!.url).toBe('wss://eventsub.wss.twitch.tv/ws');
    sockets[0]!.frame(welcome());
    await settle();
    const bodies = helix.mock.calls.map(([path, init]) => ({ path, body: JSON.parse((init as RequestInit).body as string) }));
    expect(bodies.map((b) => b.body.type)).toEqual([
      'channel.chat.message',
      'channel.chat.message_delete',
      'channel.chat.clear',
      'channel.chat.clear_user_messages',
    ]);
    expect(bodies[0]).toEqual({
      path: '/eventsub/subscriptions',
      body: {
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: '1971641', user_id: '1971641' },
        transport: { method: 'websocket', session_id: 'SESSION1' },
      },
    });
    expect(lastStatus()).toMatchObject({ status: 'live' });
  });

  it('treats 409 (already subscribed) as success', async () => {
    helix.mockImplementation(async () => new Response(null, { status: 409 }));
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'live' });
  });

  it('publishes chat, deletes and clears, ignoring duplicate deliveries', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    sockets[0]!.frame(chatMessage);
    sockets[0]!.frame(chatMessage);
    sockets[0]!.frame(messageDelete);
    sockets[0]!.frame({
      metadata: { message_id: 'c1', message_type: 'notification', message_timestamp: '2023-01-01T00:00:00Z', subscription_type: 'channel.chat.clear_user_messages' },
      payload: { event: { broadcaster_user_id: '1', target_user_id: '7734' } },
    });
    expect(ofType('chat.message')).toHaveLength(1);
    expect(ofType('chat.message')[0]).toMatchObject({ id: 'twitch:cc106a89-1814-919d-454c-f4f2f970aae7', text: 'Hi chat' });
    expect(ofType('chat.deleted')).toEqual([{ id: 'twitch:ab24e0b0-2260-4bac-94e4-05eedd4ecd0e' }]);
    expect(ofType('chat.cleared')).toEqual([{ platform: 'twitch', authorId: '7734' }]);
  });

  it('ignores malformed frames', async () => {
    connector.start();
    sockets[0]!.onmessage?.({ data: 'not json {' });
    sockets[0]!.frame({ nonsense: true });
    sockets[0]!.frame(welcome());
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'live' });
  });

  it('reports a failed subscription and reconnects with backoff', async () => {
    helix.mockImplementation(async () => new Response(null, { status: 403 }));
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('403') });
    expect(sockets[0]!.closed).toBe(true);
    timer.fire(1000);
    expect(sockets).toHaveLength(2);
  });

  it('reconnects and resubscribes after keepalive silence', async () => {
    connector.start();
    sockets[0]!.frame(welcome('S1', 10));
    await settle();
    timer.fire(15_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(lastStatus()).toMatchObject({ status: 'connecting', detail: expect.stringContaining('keepalive') });
    timer.fire(1000);
    sockets[1]!.frame(welcome('S2'));
    await settle();
    expect(helix.mock.calls.filter(([, init]) => (init as RequestInit).body!.toString().includes('S2'))).toHaveLength(4);
  });

  it('hands over to the reconnect url without resubscribing', async () => {
    connector.start();
    sockets[0]!.frame(welcome('S1'));
    await settle();
    helix.mockClear();
    sockets[0]!.frame({
      metadata: { message_id: 'r1', message_type: 'session_reconnect', message_timestamp: '2022-11-18T09:10:11Z' },
      payload: { session: { id: 'S1', status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: 'wss://eventsub.wss.twitch.tv?reconnect=1', connected_at: '2022-11-16T10:11:12Z' } },
    });
    expect(sockets[1]!.url).toBe('wss://eventsub.wss.twitch.tv?reconnect=1');
    expect(sockets[0]!.closed).toBe(false);
    sockets[0]!.frame(chatMessage); // old socket still delivers until the new welcome
    sockets[1]!.frame(welcome('S1'));
    await settle();
    expect(sockets[0]!.closed).toBe(true);
    expect(helix).not.toHaveBeenCalled();
    sockets[0]!.drop(1000); // closing the old socket must not trigger a reconnect
    expect(timer.has(1000)).toBe(false);
    expect(ofType('chat.message')).toHaveLength(1);
  });

  it('reconnects after an unexpected close', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    sockets[0]!.drop(4006);
    expect(lastStatus()).toMatchObject({ status: 'connecting', detail: expect.stringContaining('4006') });
    timer.fire(1000);
    expect(sockets).toHaveLength(2);
  });

  it('stops with a reconnect hint when authorization is revoked', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    sockets[0]!.frame({
      metadata: { message_id: 'v1', message_type: 'revocation', message_timestamp: '2022-11-16T10:11:12Z', subscription_type: 'channel.chat.message' },
      payload: { subscription: { type: 'channel.chat.message', status: 'authorization_revoked' } },
    });
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('Connections') });
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop(1000);
    expect(timer.has(1000)).toBe(false);
  });

  it('validates hourly and stops when the login is dead', async () => {
    connector.start();
    await settle();
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockResolvedValue(false);
    timer.fire(3_600_000);
    await settle();
    expect(lastStatus()).toMatchObject({ status: 'error', detail: expect.stringContaining('Reconnect Twitch') });
  });

  it('stop closes the socket and prevents reconnects', async () => {
    connector.start();
    sockets[0]!.frame(welcome());
    await settle();
    await connector.stop();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop(1006);
    expect(timer.queue).toEqual([]);
    expect(lastStatus()).toMatchObject({ status: 'disconnected' });
  });
});
