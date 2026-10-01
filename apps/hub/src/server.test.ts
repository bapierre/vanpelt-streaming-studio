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
