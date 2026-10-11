import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { readDriverEnv, runDriver, type CameraDevice, type DeviceReport, type RunningDriver } from './index';

let wss: WebSocketServer;
let port: number;
let driver: RunningDriver | null = null;
const connections: Array<{ url: string; socket: ServerSocket; messages: unknown[] }> = [];

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  port = (wss.address() as AddressInfo).port;
  wss.on('connection', (socket, req) => {
    const conn = { url: req.url ?? '', socket, messages: [] as unknown[] };
    socket.on('message', (d) => conn.messages.push(JSON.parse(d.toString())));
    connections.push(conn);
  });
});

afterEach(async () => {
  await driver?.stop();
  driver = null;
  connections.splice(0);
  await new Promise((r) => wss.close(r));
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

const publishes = (i = 0) =>
  (connections[i]?.messages ?? []).filter((m) => (m as { op: string }).op === 'publish') as Array<{
    event: { type: string; payload: { id: string; status: string } };
  }>;

function start(sets: Array<[string, string, unknown]> = []) {
  const reports = new Map<string, (r: DeviceReport) => void>();
  driver = runDriver(
    (camera, report) => {
      reports.set(camera.id, report);
      const device: CameraDevice = {
        start: () => report({ status: 'connecting', controls: [] }),
        stop: async () => {},
        set: async (key, value) => {
          sets.push([camera.id, key, value]);
        },
        ...(camera.id === 'b' && {
          record: async (on: boolean) => {
            sets.push([camera.id, 'record', on]);
          },
        }),
      };
      return device;
    },
    {
      env: {
        url: `ws://127.0.0.1:${port}/ws`,
        driverId: 'camera-test',
        token: 'tok',
        cameras: [
          { id: 'a', name: 'A', config: {} },
          { id: 'b', name: 'B', config: {} },
        ],
      },
      handleProcess: false,
      log: () => {},
    },
  );
  return reports;
}

describe('runDriver', () => {
  it('connects as the driver and publishes each camera state once open', async () => {
    start();
    await until(() => publishes().length === 2);
    expect(connections[0]!.url).toBe('/ws?driver=camera-test&token=tok');
    expect(publishes().map((p) => [p.event.type, p.event.payload.id, p.event.payload.status])).toEqual([
      ['camera.driver.state', 'a', 'connecting'],
      ['camera.driver.state', 'b', 'connecting'],
    ]);
  });

  it('routes commands to the right camera', async () => {
    const sets: Array<[string, string, unknown]> = [];
    start(sets);
    await until(() => connections.length === 1);
    connections[0]!.socket.send(
      JSON.stringify({ id: '1', type: 'camera.driver.cmd.set', ts: 0, source: 'hub', payload: { id: 'b', key: 'fov', value: '2' } }),
    );
    await until(() => sets.length === 1);
    expect(sets).toEqual([['b', 'fov', '2']]);
  });

  it('routes card record commands to devices that can record, skipping the rest', async () => {
    const sets: Array<[string, string, unknown]> = [];
    start(sets);
    await until(() => connections.length === 1);
    const send = (id: string) =>
      connections[0]!.socket.send(
        JSON.stringify({ id, type: 'camera.driver.cmd.record', ts: 0, source: 'hub', payload: { id, on: true } }),
      );
    send('a');
    send('b');
    await until(() => sets.length === 1);
    expect(sets).toEqual([['b', 'record', true]]);
  });

  it('sends only the newest state after reconnecting', async () => {
    const reports = start();
    await until(() => publishes().length === 2);
    connections[0]!.socket.terminate();
    reports.get('a')!({ status: 'ready', controls: [] });
    reports.get('a')!({ status: 'streaming', controls: [] });
    await until(() => publishes(1).length === 2);
    expect(publishes(1).map((p) => [p.event.payload.id, p.event.payload.status])).toEqual([
      ['a', 'streaming'],
      ['b', 'connecting'],
    ]);
  });
});

describe('readDriverEnv', () => {
  it('explains that drivers are started by the hub', () => {
    expect(() => readDriverEnv({})).toThrow('started by the hub');
  });
  it('parses the camera list', () => {
    const env = readDriverEnv({
      STREAMHUB_HUB_URL: 'ws://h/ws',
      STREAMHUB_DRIVER_ID: 'd',
      STREAMHUB_DRIVER_TOKEN: 't',
      STREAMHUB_DRIVER_CAMERAS: '[{"id":"a","name":"A","config":{"serial":"1"}}]',
    });
    expect(env.cameras).toEqual([{ id: 'a', name: 'A', config: { serial: '1' } }]);
  });
});
