import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import OBSWebSocket from 'obs-websocket-js';
import { Bus } from './bus/bus';
import { loadConfig } from './config';
import { ObsBridge, type ObsClient } from './obs/bridge';
import { createServer } from './server';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const cfg = loadConfig();

const bus = new Bus();
const app = await createServer({
  bus,
  port: cfg.port,
  dev: cfg.dev,
  dashboardDir: fileURLToPath(new URL('../../dashboard/dist', import.meta.url)),
});
const obs = new ObsBridge({
  bus,
  client: new OBSWebSocket() as unknown as ObsClient,
  url: cfg.obsUrl,
  password: cfg.obsPassword,
});

try {
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} is already in use. Set HUB_PORT in .env to another port.`);
    process.exit(1);
  }
  throw err;
}
obs.start();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 3000).unref();
  await obs.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
