import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Bus } from './bus/bus';
import type { ModuleHost } from './modules/host';
import { attachWebSocket, isLoopbackHost, type AuthorizeDriver } from './ws/server';

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
  /** Base URL module pages are served from; /m/<id> here redirects there. Required when modules is set. */
  modulesUrl?: string;
  /** Non-browser WS clients must present this per-run token for the dashboard role. */
  dashboardToken?: string;
};

export function allowedOrigins(port: number, dev: boolean): string[] {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (dev) origins.push('http://127.0.0.1:5173', 'http://localhost:5173'); // Vite dev server
  return origins;
}

/**
 * Module pages run third-party-built code that renders chat text, so they get a CSP that blocks
 * inline scripts; the dashboard CSP additionally locks images to keep page weight predictable.
 * `unsafe-inline` in style-src covers React style attributes, which are property assignments and
 * cannot smuggle script.
 */
const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "connect-src 'self' ws:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');
const MODULE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src https: data:",
  "media-src https: data:",
  "connect-src 'self' ws: https:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function addSecurityHooks(app: FastifyInstance, csp: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHost(req.headers.host)) {
      return reply.code(403).type('text/plain; charset=utf-8').send('Forbidden');
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('Content-Security-Policy', csp);
    }
  });
}

function closeWebSockets(app: FastifyInstance, wss: ReturnType<typeof attachWebSocket>): void {
  // Upgraded sockets keep the HTTP server open, so close them before Fastify waits on it.
  app.addHook('preClose', async () => {
    wss.clients.forEach((client) => client.terminate());
    wss.close();
  });
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  addSecurityHooks(app, DASHBOARD_CSP);
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

  // Module pages live on their own port so they cannot act on the dashboard's origin. Old URLs
  // saved in OBS still land here, so redirect them instead of breaking overlays mid-show.
  if (opts.modules && opts.modulesUrl) {
    app.get('/m/:id', async (req, reply) =>
      reply.redirect(`${opts.modulesUrl}/m/${encodeURIComponent((req.params as { id: string }).id)}/`),
    );
    app.get('/m/:id/*', async (req, reply) => {
      const params = req.params as { id: string; '*': string };
      const rest = params['*'].split('/').map(encodeURIComponent).join('/');
      return reply.redirect(`${opts.modulesUrl}/m/${encodeURIComponent(params.id)}/${rest}`);
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
    authorizeModule: opts.modules ? (id, token) => opts.modules!.authorize(id, token) : undefined,
    dashboardToken: opts.dashboardToken,
  });
  closeWebSockets(app, wss);
  return app;
}

export type ModulesServerOptions = {
  bus: Bus;
  port: number;
  modules: ModuleHost;
  logger?: FastifyServerOptions['logger'];
};

/**
 * Serves module pages and their WebSocket endpoint on a dedicated loopback port. The dashboard
 * role does not exist here, so same-origin module JS can never drive OBS or read dashboard state.
 */
export async function createModulesServer(opts: ModulesServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  addSecurityHooks(app, MODULE_CSP);
  app.get('/health', async () => ({ ok: true }));

  const modules = opts.modules;
  app.get('/m/:id', async (req, reply) => reply.redirect(`/m/${encodeURIComponent((req.params as { id: string }).id)}/`));
  app.get('/m/:id/*', async (req, reply) => {
    const params = req.params as { id: string; '*': string };
    const file = await modules.serve(params.id, params['*']);
    if (file.status === 404) return reply.code(404).type('text/plain; charset=utf-8').send(file.body);
    // Pages and the session script carry this run's session token, so they must never be cached.
    reply.header('Cache-Control', file.noStore ? 'no-store' : 'no-cache');
    if (file.etag) {
      reply.header('ETag', file.etag);
      if (req.headers['if-none-match'] === file.etag) return reply.code(304).send();
    }
    return reply.type(file.type).send(file.body);
  });

  const wss = attachWebSocket(app.server, {
    bus: opts.bus,
    allowedOrigins: allowedOrigins(opts.port, false),
    authorizeModule: (id, token) => modules.authorize(id, token),
    allowDashboard: false,
  });
  closeWebSockets(app, wss);
  return app;
}
