import { config as loadDotenv } from 'dotenv';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { WebSocket } from 'ws';
import { loadAudioConfig, saveAudioConfig } from './audio/config';
import { AudioService } from './audio/service';
import { Bus } from './bus/bus';
import { loadCameras } from './cameras/config';
import { discoverDrivers, DriverHost } from './cameras/drivers';
import { CameraService } from './cameras/service';
import { loadConfig } from './config';
import { ConnectionsService } from './connections/service';
import { ConnectorManager } from './connectors/manager';
import { TwitchAuth } from './connectors/twitch/auth';
import { TwitchConnector } from './connectors/twitch/connector';
import type { Connector, SocketLike } from './connectors/types';
import { createYouTubeApi } from './connectors/youtube/api';
import { YouTubeAuth } from './connectors/youtube/auth';
import { YouTubeConnector } from './connectors/youtube/connector';
import { ObsBridge, type ObsClient } from './obs/bridge';
import { runtimePaths } from './runtime';
import { SecretsStore } from './secrets/store';
import { createServer } from './server';

const paths = runtimePaths();
loadDotenv({ path: paths.env, quiet: true });
const cfg = loadConfig();

const bus = new Bus();
const store = new SecretsStore(paths.secrets);
await store.load();

const twitchAuth = cfg.twitchClientId ? new TwitchAuth({ clientId: cfg.twitchClientId, store }) : null;
const youtubeAuth = new YouTubeAuth({ store, redirectUri: `http://127.0.0.1:${cfg.port}/oauth/youtube/callback` });
const youtubeApi = createYouTubeApi();

// Connectors are built before the service that owns connections.state, so their auth-loss callbacks bind late.
const late: { connections?: ConnectionsService } = {};
const connectors: Connector[] = [
  new YouTubeConnector({
    bus,
    tokens: youtubeAuth,
    api: youtubeApi,
    channel: () => youtubeAuth.account() ?? 'YouTube',
    onAuthLost: (detail) => late.connections?.authLost('youtube', detail),
  }),
];
if (twitchAuth) {
  connectors.push(
    new TwitchConnector({
      bus,
      auth: twitchAuth,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onAuthLost: (detail) => late.connections?.authLost('twitch', detail),
    }),
  );
}
const manager = new ConnectorManager(connectors);
const connections = new ConnectionsService({
  bus,
  twitch: twitchAuth,
  youtube: youtubeAuth,
  youtubeApi,
  restart: (p) => manager.restart(p),
  halt: (p) => manager.halt(p),
});
late.connections = connections;

const obs = new ObsBridge({
  bus,
  client: new OBSWebSocket() as unknown as ObsClient,
  url: cfg.obsUrl,
  password: cfg.obsPassword,
  // Mixer meters and "is this mic on air" are high-volume events OBS only sends on request.
  eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters | EventSubscription.InputActiveStateChanged,
});

const cameraConfigs = await loadCameras(paths.cameras);
const drivers = await discoverDrivers(paths.modules);
const cameras = new CameraService({
  bus,
  obs,
  cameras: cameraConfigs,
  installedDrivers: new Set(drivers.keys()),
});
const audio = new AudioService({
  bus,
  obs,
  config: await loadAudioConfig(paths.audio),
  save: (c) => saveAudioConfig(paths.audio, c),
});
const driverHost = new DriverHost({
  drivers,
  cameras: cameraConfigs,
  hubUrl: `ws://${cfg.host}:${cfg.port}/ws`,
  onExit: (id, detail) => cameras.driverExited(id, detail),
});

const app = await createServer({
  bus,
  port: cfg.port,
  dev: cfg.dev,
  dashboardDir: paths.dashboard,
  youtubeCallback: (q) => connections.handleYouTubeCallback(q),
  authorizeDriver: (id, token) => driverHost.authorize(id, token),
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
cameras.start();
audio.start();
obs.start();
connections.start();
manager.startAll();
driverHost.start();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 3000).unref();
  cameras.stop();
  audio.stop();
  await Promise.all([obs.stop(), manager.stopAll(), driverHost.stop()]);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (process.env.STREAMHUB_DESKTOP === '1') {
  // Closing the parent's pipe also cleans up after an unexpectedly terminated desktop app.
  process.stdin.on('end', shutdown);
  process.stdin.resume();
  process.stdout.write(`streamhub.desktop.ready:${cfg.port}\n`);
}
