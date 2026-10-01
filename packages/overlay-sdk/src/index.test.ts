import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { connect, type HubClient, type WebSocketCtor } from './index';

const WS = WebSocket as unknown as WebSocketCtor;

let wss: WebSocketServer;
let url: string;
let sockets: ServerSocket[];
let received: Array<Record<string, unknown>>;
let requestUrls: string[];
let client: HubClient | undefined;

beforeEach(async () => {
  sockets = [];
  received = [];
  requestUrls = [];
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.on('connection', (socket, req) => {
    sockets.push(socket);
    requestUrls.push(req.url ?? '');
    socket.on('message', (d) => received.push(JSON.parse(d.toString())));
  });
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await new Promise((r) => wss.close(r));
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

const envelope = (type: string, payload: unknown = {}) =>
  JSON.stringify({ id: '01', type, ts: 1, source: 'hub', payload });

describe('connect', () => {
  it('subscribes on open and routes matching events', async () => {
    client = connect({ url, WebSocketImpl: WS });
    const obs: string[] = [];
    const exact: string[] = [];
    client.on('obs.', (e) => obs.push(e.type));
    client.on('chat.message', (e) => exact.push(e.type));
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ op: 'subscribe', topics: ['obs.', 'chat.message'] });

    sockets[0]!.send(envelope('obs.scene.changed'));
    sockets[0]!.send(envelope('chat.deleted'));
    sockets[0]!.send(envelope('chat.message'));
    await until(() => exact.length === 1);
    expect(obs).toEqual(['obs.scene.changed']);
  });

  it('queues publishes until the socket opens', async () => {
    client = connect({ url, WebSocketImpl: WS });
    client.publish('obs.cmd.setScene', { scene: 'Main' });
    await until(() => received.length === 1);
    expect(received[0]).toEqual({
      op: 'publish',
      event: { type: 'obs.cmd.setScene', payload: { scene: 'Main' } },
    });
  });

  it('resolves history by request id', async () => {
    client = connect({ url, WebSocketImpl: WS });
    const result = client.history('chat.message', 5);
    await until(() => received.length === 1);
    const req = received[0] as { reqId: string; limit: number };
    expect(req.limit).toBe(5);
    sockets[0]!.send(
      JSON.stringify({ op: 'history-result', reqId: req.reqId, events: [{ id: 'a' }] }),
    );
    await expect(result).resolves.toEqual([{ id: 'a' }]);
  });

  it('reports error ops', async () => {
    client = connect({ url, WebSocketImpl: WS });
    const errors: string[] = [];
    client.onError((code) => errors.push(code));
    await until(() => sockets.length === 1);
    sockets[0]!.send(JSON.stringify({ op: 'error', code: 'forbidden', message: 'no' }));
    await until(() => errors.length === 1);
    expect(errors).toEqual(['forbidden']);
  });

  it('reconnects and resubscribes after the hub drops', async () => {
    client = connect({ url, WebSocketImpl: WS, reconnectBaseMs: 10, reconnectMaxMs: 20 });
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    client.on('obs.', () => {});
    await until(() => received.length === 1);
    sockets[0]!.close();
    await until(() => received.length === 2);
    expect(received[1]).toEqual({ op: 'subscribe', topics: ['obs.'] });
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
  });

  it('drops queued publishes older than the queue TTL', async () => {
    client = connect({ url, WebSocketImpl: WS, reconnectBaseMs: 50, reconnectMaxMs: 50, queueTtlMs: 10 });
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    client.on('obs.', () => {});
    await until(() => received.length === 1);
    sockets[0]!.close();
    await until(() => statuses.includes('closed'));
    client.publish('obs.cmd.stopStream');
    await until(() => received.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(received.map((m) => m.op)).toEqual(['subscribe', 'subscribe']);
  });

  it('passes module identity in the URL', async () => {
    client = connect({ url, WebSocketImpl: WS, module: 'chat-overlay', token: 't0k' });
    await until(() => requestUrls.length === 1);
    expect(requestUrls[0]).toBe('/ws?module=chat-overlay&token=t0k');
  });
});
