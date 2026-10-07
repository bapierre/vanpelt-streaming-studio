/* global process, setTimeout, clearTimeout, fetch */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { bundle } from './bundle.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'apps/hub/package.json'));
const { WebSocket } = require('ws');
const children = new Set();
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-desktop-'));
  await mkdir(join(dir, 'dashboard'));
  await writeFile(
    join(dir, 'dashboard/index.html'),
    '<!doctype html><title>Desktop dashboard</title>',
  );
  await copyFile(
    join(root, 'apps/hub/src/connectors/youtube/stream_list.proto'),
    join(dir, 'stream_list.proto'),
  );
  await bundle(join(root, 'apps/hub/src/main.ts'), join(dir, 'hub.mjs'));
});

after(async () => {
  for (const child of children) {
    child.kill();
    await once(child, 'exit');
  }
  await rm(dir, { recursive: true, force: true });
});

function env() {
  return {
    ...process.env,
    HUB_PORT: undefined,
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
    NODE_ENV: 'production',
    OBS_WS_URL: 'ws://127.0.0.1:1',
    OBS_WS_PASSWORD: '',
    TWITCH_CLIENT_ID: '',
    STREAMHUB_DATA_DIR: dir,
    STREAMHUB_DASHBOARD_DIR: join(dir, 'dashboard'),
    STREAMHUB_PROTO_PATH: join(dir, 'stream_list.proto'),
    STREAMHUB_DESKTOP: '1',
  };
}

function launch() {
  const child = spawn(process.execPath, [join(dir, 'hub.mjs')], {
    env: env(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const exited = once(child, 'exit').then(([code]) => {
    children.delete(child);
    return code;
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hub startup timed out')), 8000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/^streamhub\.desktop\.ready:(\d+)$/m);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.resume();
    exited.then(() => {
      clearTimeout(timeout);
      reject(new Error('Hub exited before readiness'));
    });
  });
  return { child, ready, exited };
}

test(
  'bundled hub serves the dashboard, accepts its WebSocket origin, and stops when its parent pipe closes',
  { timeout: 10000 },
  async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    await writeFile(join(dir, '.env'), `HUB_PORT=${port}\n`);
    const { child, ready, exited } = launch();
    try {
      assert.equal(await ready, port);
      const url = `http://127.0.0.1:${port}`;
      assert.equal((await (await fetch(`${url}/health`)).json()).ok, true);
      assert.match(await (await fetch(url)).text(), /Desktop dashboard/);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: url });
      try {
        await once(ws, 'open');
      } finally {
        ws.close();
        await once(ws, 'close');
      }
      child.stdin.end();
      assert.equal(await exited, 0);
      await assert.rejects(fetch(`${url}/health`));
    } finally {
      if (children.has(child)) child.kill();
    }
  },
);

test(
  'bundled hub reports an occupied port instead of attaching to or stopping another process',
  { timeout: 10000 },
  async () => {
    const other = createServer();
    other.listen(0, '127.0.0.1');
    await once(other, 'listening');
    const port = other.address().port;
    await writeFile(join(dir, '.env'), `HUB_PORT=${port}\n`);
    try {
      const { ready, exited } = launch();
      await assert.rejects(ready, /Hub exited before readiness/);
      assert.equal(await exited, 1);
      assert.equal(other.listening, true);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  },
);

test(
  'bundled YouTube gRPC service loads the packaged proto without node_modules',
  { timeout: 10000 },
  async () => {
    const probe = join(dir, 'probe.ts');
    await writeFile(
      probe,
      `import { loadStreamListService } from ${JSON.stringify(join(root, 'apps/hub/src/connectors/youtube/api.ts'))};\nconsole.log(typeof loadStreamListService());\n`,
    );
    await bundle(probe, join(dir, 'probe.mjs'));
    const { stdout } = await promisify(execFile)(process.execPath, [join(dir, 'probe.mjs')], {
      env: env(),
    });
    assert.equal(stdout.trim(), 'function');
  },
);
