import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Bus } from './bus/bus';
import { createServer } from './server';

describe('createServer', () => {
  it('closes promptly while a WebSocket client is connected', async () => {
    const app = await createServer({
      bus: new Bus(),
      port: 0,
      dev: false,
      dashboardDir: '/nonexistent',
      logger: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const result = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('hung'), 1000)),
    ]);
    expect(result).toBe('closed');
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
