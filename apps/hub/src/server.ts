import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Bus } from './bus/bus';
import { attachWebSocket } from './ws/server';

export type ServerOptions = {
  bus: Bus;
  port: number;
  dev: boolean;
  dashboardDir: string;
  logger?: boolean;
};

export function allowedOrigins(port: number, dev: boolean): string[] {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (dev) origins.push('http://127.0.0.1:5173', 'http://localhost:5173'); // Vite dev server
  return origins;
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  app.get('/health', async () => ({ ok: true }));

  if (existsSync(opts.dashboardDir)) {
    await app.register(fastifyStatic, { root: opts.dashboardDir });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('Dashboard not built. Run `pnpm build`, or `pnpm dev` and open http://127.0.0.1:5173'),
    );
  }

  const wss = attachWebSocket(app.server, {
    bus: opts.bus,
    allowedOrigins: allowedOrigins(opts.port, opts.dev),
  });
  // Upgraded sockets keep the HTTP server open, so close them before Fastify waits on it.
  app.addHook('preClose', async () => {
    wss.clients.forEach((client) => client.terminate());
    wss.close();
  });
  return app;
}
