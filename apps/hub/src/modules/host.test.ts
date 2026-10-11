import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { injectSession, ModuleHost } from './host';

let root: string;

const manifest = (over: object = {}) => ({
  id: 'alerts',
  name: 'Alerts',
  version: '0.1.0',
  overlays: [{ id: 'popup', path: 'popup.html', width: 1920, height: 1080 }],
  subscribes: ['alert.show'],
  ...over,
});

async function addModule(dir: string, m: object, files: Record<string, string> = {}) {
  await mkdir(join(root, dir, 'dist'), { recursive: true });
  await writeFile(join(root, dir, 'manifest.json'), JSON.stringify(m));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, dir, 'dist', name), body);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modules-'));
});

describe('ModuleHost', () => {
  it('finds overlay modules, skipping driver-only and broken manifests', async () => {
    await addModule('alerts', manifest(), { 'popup.html': '<html><head></head></html>' });
    await addModule('camera-gopro', { id: 'camera-gopro', name: 'GoPro', version: '1', driver: { entry: 'src/main.ts' } });
    await addModule('wrong', manifest());
    await addModule('bad', { id: 'bad', overlays: 'nope' });
    const log = vi.fn();
    const host = await ModuleHost.discover(root, log);
    expect(host.list('http://127.0.0.1:4747')).toEqual({
      modules: [
        {
          id: 'alerts',
          name: 'Alerts',
          version: '0.1.0',
          built: true,
          overlays: [{ id: 'popup', name: 'popup', url: 'http://127.0.0.1:4747/m/alerts/popup.html', width: 1920, height: 1080 }],
        },
      ],
    });
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('skipping bad'),
      expect.stringContaining('its manifest id must be "wrong"'),
    ]);
  });

  it('serves pages with the session token injected, and assets as they are', async () => {
    await addModule('alerts', manifest(), { 'popup.html': '<!doctype html><html><head><title>x</title></head></html>', 'app.js': 'go()' });
    const host = await ModuleHost.discover(root);
    const page = await host.serve('alerts', 'popup.html');
    expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    const token = /"token":"([0-9a-f]+)"/.exec(String((page as { body: string }).body))![1]!;
    expect(host.authorize('alerts', token)?.id).toBe('alerts');
    expect(host.authorize('alerts', 'x')).toBeNull();
    expect(await host.serve('alerts', 'app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8' });
  });

  it('never serves files outside the module pages', async () => {
    await addModule('alerts', manifest(), { 'popup.html': '<html></html>' });
    await writeFile(join(root, 'alerts', 'secret.txt'), 'nope');
    await symlink(join(root, 'alerts', 'secret.txt'), join(root, 'alerts', 'dist', 'link.txt'));
    const host = await ModuleHost.discover(root);
    for (const path of ['../manifest.json', '..%2Fmanifest.json', '.hidden', 'link.txt', 'a//b', 'missing.js']) {
      expect((await host.serve('alerts', path)).status).toBe(404);
    }
    expect((await host.serve('nope', 'popup.html')).status).toBe(404);
  });

  it('says how to build a module that has no pages yet', async () => {
    await mkdir(join(root, 'alerts'), { recursive: true });
    await writeFile(join(root, 'alerts', 'manifest.json'), JSON.stringify(manifest()));
    const host = await ModuleHost.discover(root);
    expect(host.list('http://h').modules[0]!.built).toBe(false);
    expect(await host.serve('alerts', 'popup.html')).toEqual({ status: 404, body: expect.stringContaining('pnpm build') });
  });

  it('tolerates a missing modules folder', async () => {
    const host = await ModuleHost.discover(join(root, 'none'));
    expect(host.list('http://h')).toEqual({ modules: [] });
  });
});

describe('injectSession', () => {
  it('puts the session first in the head, or first in the page without one', () => {
    expect(injectSession('<html><head lang="en"><title>t</title></head></html>', 'alerts', 'ab')).toBe(
      '<html><head lang="en"><script>window.__STREAMHUB__={"module":"alerts","token":"ab"};</script><title>t</title></head></html>',
    );
    expect(injectSession('<p>hi</p>', 'alerts', 'ab')).toMatch(/^<script>.*<\/script><p>hi<\/p>$/);
  });
});
