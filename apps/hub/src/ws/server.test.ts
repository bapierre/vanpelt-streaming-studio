import { createServer, type Server } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@streamhub/shared';
import { chatMessage } from '@streamhub/shared/testing';
import { Bus } from '../bus/bus';
import { attachWebSocket, MAX_MESSAGE_BYTES } from './server';

const ORIGIN = 'http://127.0.0.1:4747';

type TestClient = {
  ws: WebSocket;
  send(msg: unknown): void;
  next(): Promise<ServerMessage>;
};

let bus: Bus;
let http: Server;
let port: number;
const clients: WebSocket[] = [];

beforeEach(async () => {
  bus = new Bus();
  http = createServer();
  attachWebSocket(http, {
    bus,
    allowedOrigins: [ORIGIN],
    authorizeDriver: (id, token) => (id === 'camera-gopro' && token === 'good' ? ['gopro'] : null),
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as AddressInfo).port;
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.terminate());
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
});

function open(origin?: string, query = ''): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, origin ? { origin } : {});
    clients.push(ws);
    const inbox: ServerMessage[] = [];
    const waiters: Array<(m: ServerMessage) => void> = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
        next: () =>
          new Promise((r) => {
            const m = inbox.shift();
            if (m) r(m);
            else waiters.push(r);
          }),
      }),
    );
  });
}

/** Round-trips a history op so every earlier op has been processed. */
async function sync(c: TestClient) {
  c.send({ op: 'history', reqId: 'sync', topic: 'none', limit: 1 });
  expect(await c.next()).toMatchObject({ op: 'history-result', reqId: 'sync' });
}

describe('origin check', () => {
  it('accepts the hub origin and non-browser clients', async () => {
    await expect(open(ORIGIN)).resolves.toBeDefined();
    await expect(open()).resolves.toBeDefined();
  });
  it('rejects other websites', async () => {
    await expect(open('https://evil.example')).rejects.toThrow('HTTP 403');
  });
  it('rejects the null origin', async () => {
    await expect(open('null')).rejects.toThrow('HTTP 403');
  });
});

describe('ops', () => {
  it('delivers only subscribed topics', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'subscribe', topics: ['obs.'] });
    await sync(c);
    bus.publish({ type: 'platform.status', payload: { platform: 'twitch', status: 'live' }, source: 't' });
    bus.publish({ type: 'obs.scene.changed', payload: { scene: 'Main' }, source: 'obs' });
    expect(await c.next()).toMatchObject({ type: 'obs.scene.changed', payload: { scene: 'Main' } });
  });

  it('sends retained state on subscribe', async () => {
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    const c = await open(ORIGIN);
    c.send({ op: 'subscribe', topics: ['obs.'] });
    expect(await c.next()).toMatchObject({ type: 'obs.connection', payload: { connected: true } });
  });

  it('stops delivery after unsubscribe', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'subscribe', topics: ['obs.'] });
    c.send({ op: 'unsubscribe', topics: ['obs.'] });
    await sync(c);
    bus.publish({ type: 'obs.scene.changed', payload: { scene: 'Main' }, source: 'obs' });
    await sync(c); // would receive the scene change first if still subscribed
  });

  it('lets dashboards publish commands, stamped with their source', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['obs.cmd.'], (e) => seen.push(e));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'obs.cmd.setScene', payload: { scene: 'Main' } } });
    await sync(c);
    expect(seen).toMatchObject([{ type: 'obs.cmd.setScene', source: 'dashboard' }]);
  });

  it('forbids publishing hub-owned events', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'chat.message', payload: chatMessage() } });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'forbidden' });
  });

  it('reports invalid payloads', async () => {
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'obs.cmd.setScene', payload: { scene: '' } } });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'bad_payload' });
  });

  it('survives garbage and unknown ops', async () => {
    const c = await open(ORIGIN);
    c.send('not json {');
    expect(await c.next()).toMatchObject({ op: 'error', code: 'bad_json' });
    c.send({ op: 'shutdown' });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'bad_op' });
    await sync(c);
  });

  it('returns chat history', async () => {
    for (let i = 0; i < 3; i++) {
      bus.publish({ type: 'chat.message', payload: chatMessage({ id: `twitch:${i}` }), source: 't' });
    }
    const c = await open(ORIGIN);
    c.send({ op: 'history', reqId: 'h1', topic: 'chat.message', limit: 2 });
    const res = await c.next();
    expect(res).toMatchObject({ op: 'history-result', reqId: 'h1' });
    if ('op' in res && res.op === 'history-result') expect(res.events).toHaveLength(2);
  });

  it('closes the connection on oversized frames', async () => {
    const c = await open(ORIGIN);
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    c.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);
  });

  it('lets dashboards send connection commands', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['connections.cmd.'], (e) => seen.push(e.payload));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'connections.cmd.connect', payload: { platform: 'twitch' } } });
    await sync(c);
    expect(seen).toEqual([{ platform: 'twitch' }]);
  });

  it('never forwards connections commands to clients', async () => {
    const watcher = await open(ORIGIN);
    watcher.send({ op: 'subscribe', topics: ['*'] });
    await sync(watcher);
    const sender = await open(ORIGIN);
    sender.send({
      op: 'publish',
      event: { type: 'connections.cmd.setYoutubeClient', payload: { clientId: 'id', clientSecret: 'TOPSECRET' } },
    });
    await sync(sender);
    await sync(watcher); // would receive the command first if it were forwarded
  });
});

describe('camera drivers', () => {
  const DRIVER = '?driver=camera-gopro&token=good';
  const driverState = (id: string) => ({
    op: 'publish',
    event: { type: 'camera.driver.state', payload: { id, status: 'ready', controls: [] } },
  });

  it('rejects a bad token and any browser origin', async () => {
    await expect(open(undefined, '?driver=camera-gopro&token=bad')).rejects.toThrow('HTTP 403');
    await expect(open(ORIGIN, DRIVER)).rejects.toThrow('HTTP 403');
  });

  it('lets a driver publish state only for its own cameras', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['camera.driver.state'], (e) => seen.push([e.source, (e.payload as { id: string }).id]));
    const d = await open(undefined, DRIVER);
    d.send(driverState('gopro'));
    d.send(driverState('sony'));
    expect(await d.next()).toMatchObject({ op: 'error', code: 'forbidden' });
    d.send({ op: 'publish', event: { type: 'obs.cmd.stopStream', payload: {} } });
    expect(await d.next()).toMatchObject({ op: 'error', code: 'forbidden' });
    expect(seen).toEqual([['driver:camera-gopro', 'gopro']]);
  });

  it('delivers only its own commands to a driver and hides driver traffic from dashboards', async () => {
    const d = await open(undefined, DRIVER);
    d.send({ op: 'subscribe', topics: ['*'] });
    await sync(d);
    const dash = await open(ORIGIN);
    dash.send({ op: 'subscribe', topics: ['*'] });
    await sync(dash);
    bus.publish({ type: 'obs.scene.changed', payload: { scene: 'X' }, source: 'obs' });
    bus.publish({ type: 'camera.driver.cmd.set', payload: { id: 'sony', key: 'k', value: 1 }, source: 'hub' });
    bus.publish({ type: 'camera.driver.cmd.set', payload: { id: 'gopro', key: 'k', value: 2 }, source: 'hub' });
    expect(await d.next()).toMatchObject({ type: 'camera.driver.cmd.set', payload: { id: 'gopro', value: 2 } });
    expect(await dash.next()).toMatchObject({ type: 'obs.scene.changed' });
    await sync(dash); // a forwarded driver command would arrive before the sync reply
  });

  it('delivers card record commands only to the owning driver', async () => {
    const d = await open(undefined, DRIVER);
    d.send({ op: 'subscribe', topics: ['*'] });
    await sync(d);
    bus.publish({ type: 'camera.driver.cmd.record', payload: { id: 'sony', on: true }, source: 'hub' });
    bus.publish({ type: 'camera.driver.cmd.record', payload: { id: 'gopro', on: true }, source: 'hub' });
    expect(await d.next()).toMatchObject({ type: 'camera.driver.cmd.record', payload: { id: 'gopro', on: true } });
  });

  it('lets dashboards send camera commands', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['camera.cmd.'], (e) => seen.push(e.payload));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'camera.cmd.take', payload: { id: 'gopro' } } });
    await sync(c);
    expect(seen).toEqual([{ id: 'gopro' }]);
  });

  it('lets dashboards send audio commands', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['audio.cmd.'], (e) => seen.push(e.payload));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'audio.cmd.set', payload: { id: 'host', muted: true } } });
    await sync(c);
    expect(seen).toEqual([{ id: 'host', muted: true }]);
  });

  it('lets dashboards send headset commands', async () => {
    const seen: unknown[] = [];
    bus.subscribe(['headsets.cmd.'], (e) => seen.push(e.payload));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'headsets.cmd.setSend', payload: { id: 'guest', source: 'mic:host', on: false } } });
    await sync(c);
    expect(seen).toEqual([{ id: 'guest', source: 'mic:host', on: false }]);
  });

  it('lets dashboards send alert and goal commands, but not fake an alert', async () => {
    const seen: string[] = [];
    bus.subscribe(['alert.', 'goal.'], (e) => seen.push(e.type));
    const c = await open(ORIGIN);
    c.send({ op: 'publish', event: { type: 'alert.cmd.test', payload: { kind: 'raid' } } });
    c.send({ op: 'publish', event: { type: 'goal.cmd.reset', payload: { id: 'subs' } } });
    c.send({
      op: 'publish',
      event: { type: 'alert.event', payload: { id: 'x', kind: 'tip', platform: 'youtube', user: { id: '1', name: 'A' }, at: 1 } },
    });
    expect(await c.next()).toMatchObject({ op: 'error', code: 'forbidden' });
    expect(seen).toEqual(['alert.cmd.test', 'goal.cmd.reset']);
  });
});

describe('robustness', () => {
  it('survives a malformed upgrade path from any origin', async () => {
    await new Promise<void>((resolve) => {
      const sock = tcpConnect(port, '127.0.0.1', () =>
        sock.write(
          'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Origin: https://evil.example\r\n\r\n',
        ),
      );
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
    });
    await expect(open(ORIGIN)).resolves.toBeDefined();
  });
});
