import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { backoffDelay } from '../util/backoff';
import { describeError } from '../util/errors';
import { realTimer, type Timer } from '../util/timer';
import type { CameraConfig } from './config';

const ManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    version: z.string().min(1),
    driver: z.object({ entry: z.string().min(1) }).optional(),
  })
  .loose();

export type DriverModule = { id: string; name: string; entry: string };

/** Scans `modules/<id>/manifest.json` for modules that ship a camera driver. Bad manifests are skipped. */
export async function discoverDrivers(
  modulesDir: string,
  log: (msg: string) => void = console.warn,
): Promise<Map<string, DriverModule>> {
  const found = new Map<string, DriverModule>();
  let dirs: string[];
  try {
    dirs = (await readdir(modulesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return found;
  }
  for (const dir of dirs.sort()) {
    const path = join(modulesDir, dir, 'manifest.json');
    let json: unknown;
    try {
      json = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[drivers] skipping ${path}: ${describeError(err)}`);
      continue;
    }
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success) {
      log(`[drivers] skipping ${path}: invalid manifest`);
      continue;
    }
    const m = parsed.data;
    if (!m.driver) continue;
    if (m.id !== dir) {
      log(`[drivers] skipping ${path}: id "${m.id}" must match the folder name`);
      continue;
    }
    const moduleDir = join(modulesDir, dir);
    const entry = resolve(moduleDir, m.driver.entry);
    const rel = relative(moduleDir, entry);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      log(`[drivers] skipping ${path}: driver entry must stay inside the module folder`);
      continue;
    }
    found.set(m.id, { id: m.id, name: m.name, entry });
  }
  return found;
}

export type ChildLike = {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ChildLike;

export type DriverHostOptions = {
  drivers: Map<string, DriverModule>;
  cameras: CameraConfig[];
  hubUrl: string;
  onExit: (driverId: string, detail: string) => void;
  spawn?: SpawnFn;
  /** Node flags that let the child run a TypeScript entry; null when only .js entries can run. */
  tsLoaderArgs?: string[] | null;
  timer?: Timer;
  rand?: () => number;
  now?: () => number;
  log?: (msg: string) => void;
};

type Running = {
  module: DriverModule;
  cameras: CameraConfig[];
  child: ChildLike | null;
  token: string | null;
  attempt: number;
  launchedAt: number;
  retry: unknown;
};

const defaultSpawn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });

function defaultTsLoaderArgs(): string[] | null {
  try {
    return ['--import', import.meta.resolve('tsx')];
  } catch {
    return null;
  }
}

/** Only what a driver needs: drivers are third-party code and must not see the hub's .env secrets. */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG'];

/** A driver that stayed up this long counts as healthy; its next crash restarts from the first backoff step. */
export const STABLE_DRIVER_MS = 30_000;

/** Runs each camera driver as its own process and restarts it with backoff when it exits. */
export class DriverHost {
  private readonly running = new Map<string, Running>();
  private stopped = true;
  private readonly spawn: SpawnFn;
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly tsLoaderArgs: string[] | null;

  constructor(private readonly opts: DriverHostOptions) {
    this.spawn = opts.spawn ?? defaultSpawn;
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
    this.tsLoaderArgs = opts.tsLoaderArgs === undefined ? defaultTsLoaderArgs() : opts.tsLoaderArgs;
  }

  start() {
    this.stopped = false;
    const byDriver = new Map<string, CameraConfig[]>();
    for (const cam of this.opts.cameras) {
      if (!cam.driver || !this.opts.drivers.has(cam.driver)) continue;
      byDriver.set(cam.driver, [...(byDriver.get(cam.driver) ?? []), cam]);
    }
    for (const [id, cameras] of byDriver) {
      const r: Running = {
        module: this.opts.drivers.get(id)!,
        cameras,
        child: null,
        token: null,
        attempt: 0,
        launchedAt: 0,
        retry: null,
      };
      this.running.set(id, r);
      this.launch(r);
    }
  }

  /** Validates a driver's WebSocket token; returns the camera ids it may control. */
  authorize(driverId: string, token: string): string[] | null {
    const r = this.running.get(driverId);
    if (!r?.token) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(r.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return r.cameras.map((c) => c.id);
  }

  async stop() {
    this.stopped = true;
    const exits: Promise<void>[] = [];
    for (const r of this.running.values()) {
      if (r.retry !== null) this.timer.clear(r.retry);
      r.retry = null;
      r.token = null;
      const child = r.child;
      if (!child) continue;
      exits.push(
        new Promise<void>((done) => {
          const force = setTimeout(() => {
            child.kill('SIGKILL');
            done();
          }, 2000);
          force.unref?.();
          child.on('exit', () => {
            clearTimeout(force);
            done();
          });
        }),
      );
      child.kill('SIGTERM');
    }
    await Promise.all(exits);
  }

  private launch(r: Running) {
    if (this.stopped) return;
    const { module } = r;
    const isTs = /\.[cm]?ts$/.test(module.entry);
    if (isTs && !this.tsLoaderArgs) {
      this.opts.onExit(module.id, 'Driver is TypeScript but no TypeScript loader is available; ship a .js entry');
      return;
    }
    r.token = randomBytes(24).toString('hex');
    r.launchedAt = this.now();
    const env: Record<string, string> = {};
    for (const k of PASSTHROUGH_ENV) if (process.env[k]) env[k] = process.env[k]!;
    Object.assign(env, {
      STREAMHUB_HUB_URL: this.opts.hubUrl,
      STREAMHUB_DRIVER_ID: module.id,
      STREAMHUB_DRIVER_TOKEN: r.token,
      STREAMHUB_DRIVER_CAMERAS: JSON.stringify(r.cameras.map((c) => ({ id: c.id, name: c.name, config: c.driverConfig }))),
    });
    const args = [...(isTs ? this.tsLoaderArgs! : []), module.entry];
    let child: ChildLike;
    try {
      child = this.spawn(process.execPath, args, { cwd: join(module.entry, '..'), env });
    } catch (err) {
      this.onChildGone(r, null, `Driver failed to start: ${describeError(err)}`);
      return;
    }
    r.child = child;
    const prefix = `[driver:${module.id}]`;
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', (line) => this.log(`${prefix} ${line}`));
    }
    let gone = false;
    child.on('error', (err) => {
      if (gone) return;
      gone = true;
      this.onChildGone(r, child, `Driver failed: ${describeError(err)}`);
    });
    child.on('exit', (code, signal) => {
      if (gone) return;
      gone = true;
      this.onChildGone(r, child, `Driver exited (${signal ?? `code ${code}`})`);
    });
  }

  private onChildGone(r: Running, child: ChildLike | null, detail: string) {
    if (child && r.child !== child) return;
    r.child = null;
    r.token = null;
    if (this.stopped) return;
    this.log(`[drivers] ${r.module.id}: ${detail}`);
    this.opts.onExit(r.module.id, `${detail}; restarting`);
    // A crash-looping driver (dies seconds after every launch) keeps backing off; only a run
    // that stayed up long enough to be useful earns a reset.
    if (this.now() - r.launchedAt >= STABLE_DRIVER_MS) r.attempt = 0;
    const delay = backoffDelay(r.attempt++, this.rand);
    r.retry = this.timer.set(() => {
      r.retry = null;
      this.launch(r);
    }, delay);
  }
}
