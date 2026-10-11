import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Bus } from './bus/bus';
import type { ModuleHost } from './modules/host';
import { attachWebSocket, type AuthorizeDriver } from './ws/server';

export type ServerOptions = {
  bus: Bus;
  port: number;
  dev: boolean;
  dashboardDir: string;
  logger?: FastifyServerOptions['logger'];
  youtubeCallback?: (query: Record<string, string | undefined>) => Promise<string>;
  xCallback?: (query: Record<string, string | undefined>) => Promise<string>;
  authorizeDriver?: AuthorizeDriver;
  modules?: ModuleHost;
};

export function allowedOrigins(port: number, dev: boolean): string[] {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (dev) origins.push('http://127.0.0.1:5173', 'http://localhost:5173'); // Vite dev server
  return origins;
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  app.get('/health', async () => ({ ok: true }));

  if (opts.youtubeCallback) {
    const callback = opts.youtubeCallback;
    // The query carries a one-time auth code, so this route must never be request-logged.
    app.get('/oauth/youtube/callback', { logLevel: 'silent' }, async (req, reply) =>
      reply.type('text/plain; charset=utf-8').send(await callback(req.query as Record<string, string | undefined>)),
    );
  }

  if (opts.xCallback) {
    const callback = opts.xCallback;
    app.get('/oauth/x/callback', { logLevel: 'silent' }, async (req, reply) =>
      reply.type('text/plain; charset=utf-8').send(await callback(req.query as Record<string, string | undefined>)),
    );
  }

  const modules = opts.modules;
  if (modules) {
    app.get('/m/:id', async (req, reply) => reply.redirect(`/m/${encodeURIComponent((req.params as { id: string }).id)}/`));
    app.get('/m/:id/*', async (req, reply) => {
      const params = req.params as { id: string; '*': string };
      const file = await modules.serve(params.id, params['*']);
      reply.header('X-Content-Type-Options', 'nosniff');
      if (file.status === 404) return reply.code(404).type('text/plain; charset=utf-8').send(file.body);
      // Pages carry this run's session token, so they must never be cached.
      reply.header('Cache-Control', file.type.startsWith('text/html') ? 'no-store' : 'no-cache');
      if (file.status === 200 && file.etag) {
        reply.header('ETag', file.etag);
        if (req.headers['if-none-match'] === file.etag) return reply.code(304).send();
      }
      return reply.type(file.type).send(file.body);
    });
  }

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
    authorizeDriver: opts.authorizeDriver,
    authorizeModule: modules ? (id, token) => modules.authorize(id, token) : undefined,
  });
  // Upgraded sockets keep the HTTP server open, so close them before Fastify waits on it.
  app.addHook('preClose', async () => {
    wss.clients.forEach((client) => client.terminate());
    wss.close();
  });
  return app;
}
