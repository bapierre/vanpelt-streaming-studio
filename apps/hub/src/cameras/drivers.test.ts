import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FakeTimer } from '../testing/timer';
import type { CameraConfig } from './config';
import { discoverDrivers, DriverHost, type ChildLike, type DriverModule, type SpawnFn } from './drivers';

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const cam = (id: string, driver: string | null): CameraConfig => ({
  id,
  name: id,
  driver,
  scene: id,
  source: id,
  driverConfig: { serial: 'C123' },
});

const gopro: DriverModule = { id: 'camera-gopro', name: 'GoPro', entry: '/m/camera-gopro/src/main.ts' };

function setup(cameras: CameraConfig[] = [cam('gopro', 'camera-gopro'), cam('sony', null)]) {
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string>; child: FakeChild }> = [];
  const spawn: SpawnFn = (command, args, opts) => {
    const child = new FakeChild();
    spawned.push({ command, args, env: opts.env, child });
    return child;
  };
  const exits: Array<[string, string]> = [];
  const logs: string[] = [];
  const timer = new FakeTimer();
  const host = new DriverHost({
    drivers: new Map([[gopro.id, gopro]]),
    cameras,
    hubUrl: 'ws://127.0.0.1:4747/ws',
    onExit: (id, detail) => exits.push([id, detail]),
    spawn,
    tsLoaderArgs: ['--import', 'tsx'],
    timer,
    rand: () => 0,
    log: (m) => logs.push(m),
  });
  return { host, spawned, exits, logs, timer };
}

describe('DriverHost', () => {
  it('starts one process per driver with its cameras, a token and no hub secrets', () => {
    process.env.OBS_WS_PASSWORD = 'hunter2';
    const t = setup();
    t.host.start();
    expect(t.spawned).toHaveLength(1);
    const { command, args, env } = t.spawned[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['--import', 'tsx', gopro.entry]);
    expect(env.STREAMHUB_DRIVER_ID).toBe('camera-gopro');
    expect(JSON.parse(env.STREAMHUB_DRIVER_CAMERAS!)).toEqual([{ id: 'gopro', name: 'gopro', config: { serial: 'C123' } }]);
    expect(env.STREAMHUB_DRIVER_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(env.OBS_WS_PASSWORD).toBeUndefined();
    delete process.env.OBS_WS_PASSWORD;
  });

  it('authorizes only the current token of a running driver', () => {
    const t = setup();
    t.host.start();
    const token = t.spawned[0]!.env.STREAMHUB_DRIVER_TOKEN!;
    expect(t.host.authorize('camera-gopro', token)).toEqual(['gopro']);
    expect(t.host.authorize('camera-gopro', 'x'.repeat(48))).toBeNull();
    expect(t.host.authorize('camera-other', token)).toBeNull();
  });

  it('reports an exit, revokes the token and restarts with backoff', () => {
    const t = setup();
    t.host.start();
    const first = t.spawned[0]!;
    first.child.emit('exit', 1, null);
    expect(t.exits).toEqual([['camera-gopro', 'Driver exited (code 1); restarting']]);
    expect(t.host.authorize('camera-gopro', first.env.STREAMHUB_DRIVER_TOKEN!)).toBeNull();
    t.timer.fire(500);
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[1]!.env.STREAMHUB_DRIVER_TOKEN).not.toBe(first.env.STREAMHUB_DRIVER_TOKEN);
    t.spawned[1]!.child.emit('exit', 1, null);
    expect(t.timer.has(1000)).toBe(true); // backoff grows until the driver connects
  });

  it('prefixes driver output in the hub log', async () => {
    const t = setup();
    t.host.start();
    t.spawned[0]!.child.stderr.write('camera not reachable\n');
    await new Promise((r) => setImmediate(r));
    expect(t.logs).toContain('[driver:camera-gopro] camera not reachable');
  });

  it('stops drivers without restarting them', async () => {
    const t = setup();
    t.host.start();
    await t.host.stop();
    expect(t.spawned[0]!.child.killed).toEqual(['SIGTERM']);
    expect(t.exits).toEqual([]);
    expect(t.timer.queue).toEqual([]);
  });

  it('refuses a TypeScript driver when no loader is available', () => {
    const exits: Array<[string, string]> = [];
    const host = new DriverHost({
      drivers: new Map([[gopro.id, gopro]]),
      cameras: [cam('gopro', 'camera-gopro')],
      hubUrl: 'ws://x',
      onExit: (id, d) => exits.push([id, d]),
      spawn: () => {
        throw new Error('should not spawn');
      },
      tsLoaderArgs: null,
    });
    host.start();
    expect(exits[0]?.[1]).toContain('no TypeScript loader');
  });

  it('runs a real driver process and sees it exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drv-'));
    const entry = join(dir, 'driver.mjs');
    await writeFile(entry, 'console.log(`hello ${process.env.STREAMHUB_DRIVER_ID}`); process.exit(3);');
    const exited = new Promise<string>((resolve) => {
      const host = new DriverHost({
        drivers: new Map([['camera-x', { id: 'camera-x', name: 'X', entry }]]),
        cameras: [cam('x', 'camera-x')],
        hubUrl: 'ws://x',
        onExit: (_id, detail) => {
          void host.stop();
          resolve(detail);
        },
        log: () => {},
      });
      host.start();
    });
    expect(await exited).toBe('Driver exited (code 3); restarting');
  });
});

describe('discoverDrivers', () => {
  it('finds modules with a driver and skips the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-'));
    const mod = async (dir: string, manifest: unknown) => {
      await mkdir(join(root, dir));
      await writeFile(join(root, dir, 'manifest.json'), JSON.stringify(manifest));
    };
    await mod('camera-gopro', { id: 'camera-gopro', name: 'GoPro', version: '0.1.0', driver: { entry: 'src/main.ts' } });
    await mod('overlay-only', { id: 'overlay-only', name: 'O', version: '1', overlays: [] });
    await mod('wrong-name', { id: 'other', name: 'W', version: '1', driver: { entry: 'a.js' } });
    await mod('escape', { id: 'escape', name: 'E', version: '1', driver: { entry: '../../evil.js' } });
    const logs: string[] = [];
    const found = await discoverDrivers(root, (m) => logs.push(m));
    expect([...found.keys()]).toEqual(['camera-gopro']);
    expect(found.get('camera-gopro')?.entry).toBe(join(root, 'camera-gopro/src/main.ts'));
    expect(logs).toHaveLength(2);
  });

  it('returns nothing when the modules folder is missing', async () => {
    expect((await discoverDrivers('/nonexistent/modules')).size).toBe(0);
  });
});
