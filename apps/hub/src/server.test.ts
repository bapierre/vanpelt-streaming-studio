import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Bus } from './bus/bus';
import { ModuleHost } from './modules/host';
import { createModulesServer, createServer } from './server';

async function discoverModules() {
  const root = await mkdtemp(join(tmpdir(), 'mods-'));
  await mkdir(join(root, 'alerts', 'dist', 'assets'), { recursive: true });
  await writeFile(
    join(root, 'alerts', 'manifest.json'),
    JSON.stringify({ id: 'alerts', name: 'Alerts', version: '1', overlays: [{ id: 'p', path: 'popup.html', width: 1, height: 1 }] }),
  );
  await writeFile(join(root, 'alerts', 'dist', 'popup.html'), '<html><head></head></html>');
  await writeFile(join(root, 'alerts', 'dist', 'assets', 'popup.js'), 'console.log(1)');
  return ModuleHost.discover(root);
}

describe('createServer', () => {
  it('closes promptly while a WebSocket client is connected', async () => {
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: false,
      dashboardToken: 'tok',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
    await new Promise((r) => ws.on('open', r));
    const result = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('hung'), 1000)),
    ]);
    expect(result).toBe('closed');
  });

  it('refuses requests with a non-loopback Host header', async () => {
    const app = await createServer({ bus: new Bus(), port: 0, dev: false, dashboardDir: '/nonexistent', logger: false });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('sets clickjacking and content-type guards on every response', async () => {
    const app = await createServer({ bus: new Bus(), port: 0, dev: false, dashboardDir: '/nonexistent', logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('redirects legacy module URLs to the modules listener', async () => {
    const modules = await discoverModules();
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: false,
      modules,
      modulesUrl: 'http://127.0.0.1:4748',
    });
    const res = await app.inject({ method: 'GET', url: '/m/alerts/popup.html' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://127.0.0.1:4748/m/alerts/popup.html');
    await app.close();
  });
});
describe('YouTube OAuth callback', () => {
  it('passes the query to the callback handler and returns its text', async () => {
    const seen: unknown[] = [];
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: false,
      youtubeCallback: async (q) => {
        seen.push(q);
        return 'YouTube is connected. You can close this tab.';
      },
    });
    const res = await app.inject({ method: 'GET', url: '/oauth/youtube/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('YouTube is connected. You can close this tab.');
    expect(seen).toEqual([{ code: 'abc', state: 'xyz' }]);
    await app.close();
  });

  it('never logs the callback URL or its one-time code', async () => {
    let logged = '';
    const stream = { write: (line: string) => void (logged += line) };
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: { level: 'info', stream },
      youtubeCallback: async () => 'ok',
    });
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/oauth/youtube/callback?code=SECRETCODE&state=SECRETSTATE' });
    await app.close();
    expect(logged).toContain('/health'); // the logger is live, so the absence below is meaningful
    expect(logged).not.toContain('SECRETCODE');
    expect(logged).not.toContain('SECRETSTATE');
    expect(logged).not.toContain('/oauth/youtube/callback');
  });
});
describe('X OAuth callback', () => {
  it('passes the query to the callback handler without logging the code', async () => {
    let logged = '';
    const seen: unknown[] = [];
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: { level: 'info', stream: { write: (line: string) => void (logged += line) } },
      xCallback: async (q) => {
        seen.push(q);
        return 'X is connected. You can close this tab.';
      },
    });
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/oauth/x/callback?code=SECRETCODE&state=SECRETSTATE' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('X is connected. You can close this tab.');
    expect(seen).toEqual([{ code: 'SECRETCODE', state: 'SECRETSTATE' }]);
    expect(logged).toContain('/health');
    expect(logged).not.toContain('SECRETCODE');
    expect(logged).not.toContain('/oauth/x/callback');
  });

  it('is not served when no X handler is configured', async () => {
    const app = await createServer({ bus: new Bus(), port: 0, dev: false, dashboardDir: '/nonexistent', logger: false });
    const res = await app.inject({ method: 'GET', url: '/oauth/x/callback?code=a' });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});
describe('module pages (dedicated listener)', () => {
  it('serves a page referencing its session script, serves the script, and refuses traversal', async () => {
    const app = await createModulesServer({ bus: new Bus(), port: 0, modules: await discoverModules(), logger: false });
    const page = await app.inject({ method: 'GET', url: '/m/alerts/popup.html' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).toContain('/m/alerts/__session.js');
    expect(page.body).not.toContain('window.__STREAMHUB__=');
    const session = await app.inject({ method: 'GET', url: '/m/alerts/__session.js' });
    expect(session.statusCode).toBe(200);
    expect(session.headers['cache-control']).toBe('no-store');
    expect(session.headers.etag).toBeUndefined();
    expect(session.body).toContain('window.__STREAMHUB__=');
    expect((await app.inject({ method: 'GET', url: '/m/alerts/../manifest.json' })).body).not.toContain('overlays');
    expect((await app.inject({ method: 'GET', url: '/m/alerts/%2e%2e/manifest.json' })).body).not.toContain('overlays');
    expect((await app.inject({ method: 'GET', url: '/m/alerts/..%2fmanifest.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/m/alerts' })).statusCode).toBe(302);
    await app.close();
  });

  it('answers 304 when a module asset matches its ETag', async () => {
    const app = await createModulesServer({ bus: new Bus(), port: 0, modules: await discoverModules(), logger: false });
    const first = await app.inject({ method: 'GET', url: '/m/alerts/assets/popup.js' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    const second = await app.inject({ method: 'GET', url: '/m/alerts/assets/popup.js', headers: { 'if-none-match': etag! } });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    // HTML never gets an ETag: it references the session token.
    const page = await app.inject({ method: 'GET', url: '/m/alerts/popup.html' });
    expect(page.headers.etag).toBeUndefined();
    await app.close();
  });
});
