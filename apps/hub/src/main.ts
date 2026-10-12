import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { WebSocket } from 'ws';
import { loadAlertsFile, saveAlertsFile } from './alerts/config';
import { AlertService } from './alerts/service';
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
import { createXApi } from './connectors/x/api';
import { XAuth } from './connectors/x/auth';
import { XConnector } from './connectors/x/connector';
import { DestinationsService } from './destinations/service';
import { loadHeadsetsConfig, saveHeadsetsConfig } from './headsets/config';
import { listOutputDevices } from './headsets/outputs';
import { installAudioMonitor } from './headsets/plugin';
import { HeadsetService } from './headsets/service';
import { ModuleHost } from './modules/host';
import { ObsBridge, type ObsClient } from './obs/bridge';
import { PreviewService } from './obs/previews';
import { RecordingService } from './recording/service';
import { loadObsSettings, ObsSettingsService } from './obs/settings';
import { runtimePaths } from './runtime';
import { SecretsStore } from './secrets/store';
import { createModulesServer, createServer } from './server';

const paths = runtimePaths();
loadDotenv({ path: paths.env, quiet: true });
const cfg = loadConfig();

const bus = new Bus();
const store = new SecretsStore(paths.secrets);
await store.load();

// TwitchAuth always exists: the app client id can arrive from the dashboard at any time, no restart.
const twitchAuth = new TwitchAuth({ clientId: cfg.twitchClientId, store });
const youtubeAuth = new YouTubeAuth({ store, redirectUri: `http://127.0.0.1:${cfg.port}/oauth/youtube/callback` });
const youtubeApi = createYouTubeApi();
const xAuth = new XAuth({ store, redirectUri: `http://127.0.0.1:${cfg.port}/oauth/x/callback` });
const xApi = createXApi();

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
  new XConnector({
    bus,
    tokens: xAuth,
    api: xApi,
    onAuthLost: (detail) => late.connections?.authLost('x', detail),
  }),
  new TwitchConnector({
    bus,
    auth: twitchAuth,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onAuthLost: (detail) => late.connections?.authLost('twitch', detail),
  }),
];
const manager = new ConnectorManager(connectors);
const connections = new ConnectionsService({
  bus,
  twitch: twitchAuth,
  youtube: youtubeAuth,
  youtubeApi,
  x: xAuth,
  xApi,
  restart: (p) => manager.restart(p),
  halt: (p) => manager.halt(p),
});
late.connections = connections;

const obsInitial = loadObsSettings(store, { url: cfg.obsUrl, password: cfg.obsPassword });
const obs = new ObsBridge({
  bus,
  client: new OBSWebSocket() as unknown as ObsClient,
  url: obsInitial.url,
  password: obsInitial.password,
  // Mixer meters and "is this mic on air" are high-volume events OBS only sends on request.
  eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters | EventSubscription.InputActiveStateChanged,
});
const obsSettings = new ObsSettingsService({ bus, store, bridge: obs, initial: obsInitial });
const destinations = new DestinationsService({ bus, store, obs });
const previews = new PreviewService({ bus, obs });

const cameraConfigs = await loadCameras(paths.cameras);
const drivers = await discoverDrivers(paths.modules);
const modules = await ModuleHost.discover(paths.modules);
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
// The desktop app bundles the Audio Monitor plugin and points the hub at it; a bare hub skips this.
const pluginInstall = await installAudioMonitor({
  resourceDir: process.env.STREAMHUB_AUDIO_MONITOR_DIR,
  log: (m) => console.warn(m),
});
const headsets = new HeadsetService({
  bus,
  obs,
  config: await loadHeadsetsConfig(paths.headsets),
  save: (c) => saveHeadsetsConfig(paths.headsets, c),
  listOutputs: () => listOutputDevices(),
  pluginInstalled: pluginInstall === 'installed' || pluginInstall === 'current' || pluginInstall === 'user-install',
  cameras: cameraConfigs.map((c) => ({ name: c.name, source: c.source })),
});
const recording = new RecordingService({ bus, obs, cameras: cameraConfigs });
const alerts = new AlertService({
  bus,
  file: await loadAlertsFile(paths.alerts),
  save: (f) => saveAlertsFile(paths.alerts, f),
});
const driverHost = new DriverHost({
  drivers,
  cameras: cameraConfigs,
  hubUrl: `ws://${cfg.host}:${cfg.port}/ws`,
  onExit: (id, detail) => cameras.driverExited(id, detail),
});

// Non-browser clients (local tools, tests) prove they may drive the hub with this per-run token;
// browsers prove it with their Origin. Written owner-only so other OS users cannot read it.
const dashboardToken = randomBytes(24).toString('base64url');
await mkdir(dirname(paths.secrets), { recursive: true, mode: 0o700 });
await writeFile(join(dirname(paths.secrets), 'dashboard-token'), `${dashboardToken}\n`, { mode: 0o600 });

const modulesUrl = `http://${cfg.host}:${cfg.modulesPort}`;
const app = await createServer({
  bus,
  port: cfg.port,
  dev: cfg.dev,
  dashboardDir: paths.dashboard,
  youtubeCallback: (q) => connections.handleYouTubeCallback(q),
  xCallback: (q) => connections.handleXCallback(q),
  authorizeDriver: (id, token) => driverHost.authorize(id, token),
  modules,
  modulesUrl,
  dashboardToken,
});
const modulesApp = await createModulesServer({ bus, port: cfg.modulesPort, modules });

const listen = async (server: typeof app, port: number, envKey: string) => {
  try {
    await server.listen({ host: cfg.host, port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set ${envKey} in .env to another port.`);
      process.exit(1);
    }
    throw err;
  }
};
await listen(app, cfg.port, 'HUB_PORT');
await listen(modulesApp, cfg.modulesPort, 'HUB_MODULES_PORT');
bus.publish({ type: 'modules.list', payload: modules.list(modulesUrl), source: 'hub' });
cameras.start();
audio.start();
headsets.start();
recording.start();
alerts.start();
obsSettings.start();
destinations.start();
previews.start();
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
  headsets.stop();
  recording.stop();
  alerts.stop();
  obsSettings.stop();
  destinations.stop();
  previews.stop();
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
