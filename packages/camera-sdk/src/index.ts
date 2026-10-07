import { connect, type HubClient, type WebSocketCtor } from '@streamhub/overlay-sdk';
import type {
  CameraControl,
  CameraStatus,
  CameraTelemetry,
  ControlValue,
  EventPayload,
  ObsInputSuggestion,
} from '@streamhub/shared';
import { WebSocket } from 'ws';

export type { CameraControl, CameraStatus, CameraTelemetry, ControlValue, ObsInputSuggestion };

/** One camera from `.streamhub/cameras.json`; `config` is its `driverConfig`. */
export type DriverCamera = { id: string; name: string; config: Record<string, unknown> };

/** What a device tells the hub. Control keys must not start with `obs.` (those belong to the hub). */
export type DeviceReport = {
  status: CameraStatus;
  detail?: string;
  telemetry?: CameraTelemetry;
  controls: CameraControl[];
  obsInput?: ObsInputSuggestion;
};

export interface CameraDevice {
  /** Begin connecting; keep retrying on your own and report progress through `report`. Must not throw. */
  start(): void;
  stop(): Promise<void>;
  /** Apply one control. A rejection is logged; report the resulting state either way. */
  set(key: string, value: ControlValue): Promise<void>;
}

export type DeviceFactory = (camera: DriverCamera, report: (r: DeviceReport) => void) => CameraDevice;

export type DriverEnv = { url: string; driverId: string; token: string; cameras: DriverCamera[] };

/** Reads the launch details the hub passes to every driver process. */
export function readDriverEnv(env: Record<string, string | undefined> = process.env): DriverEnv {
  const { STREAMHUB_HUB_URL: url, STREAMHUB_DRIVER_ID: driverId, STREAMHUB_DRIVER_TOKEN: token } = env;
  if (!url || !driverId || !token || !env.STREAMHUB_DRIVER_CAMERAS) {
    throw new Error('missing STREAMHUB_* variables: camera drivers are started by the hub, not by hand');
  }
  return { url, driverId, token, cameras: JSON.parse(env.STREAMHUB_DRIVER_CAMERAS) as DriverCamera[] };
}

export type RunOptions = {
  env?: DriverEnv;
  WebSocketImpl?: WebSocketCtor;
  log?: (msg: string) => void;
  /** Exit on SIGTERM/SIGINT and when the hub closes our stdin (default true). */
  handleProcess?: boolean;
};

export type RunningDriver = { hub: HubClient; stop(): Promise<void> };

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Connects to the hub, creates one device per camera and routes commands and state between them. */
export function runDriver(factory: DeviceFactory, opts: RunOptions = {}): RunningDriver {
  const env = opts.env ?? readDriverEnv();
  const log = opts.log ?? ((m: string) => console.error(m));
  const url = new URL(env.url);
  url.searchParams.set('driver', env.driverId);
  const hub = connect({
    url: url.toString(),
    token: env.token,
    WebSocketImpl: opts.WebSocketImpl ?? (WebSocket as unknown as WebSocketCtor),
  });

  // Only the newest state matters, so send it when the socket is open instead of queueing stale ones.
  const latest = new Map<string, EventPayload<'camera.driver.state'>>();
  let open = false;
  const send = (id: string) => {
    const state = latest.get(id);
    if (open && state) hub.publish('camera.driver.state', state);
  };
  hub.onStatus((s) => {
    open = s === 'open';
    if (open) for (const id of latest.keys()) send(id);
  });
  hub.onError((code, message) => log(`hub rejected a message (${code}): ${message}`));

  const devices = new Map<string, CameraDevice>();
  for (const camera of env.cameras) {
    const report = (r: DeviceReport) => {
      latest.set(camera.id, { id: camera.id, ...r });
      send(camera.id);
    };
    try {
      devices.set(camera.id, factory(camera, report));
    } catch (err) {
      log(`${camera.id}: cannot create device: ${describe(err)}`);
      report({ status: 'error', detail: describe(err), controls: [] });
    }
  }

  hub.on('camera.driver.cmd.set', (e) => {
    const { id, key, value } = e.payload as EventPayload<'camera.driver.cmd.set'>;
    devices.get(id)?.set(key, value).catch((err) => log(`${id}: ${key} failed: ${describe(err)}`));
  });
  devices.forEach((d) => d.start());

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= Promise.allSettled([...devices.values()].map((d) => d.stop())).then(() => hub.close());
    return stopping;
  };

  if (opts.handleProcess ?? true) {
    const exit = () => void stop().then(() => process.exit(0));
    process.once('SIGTERM', exit);
    process.once('SIGINT', exit);
    // The hub holds our stdin open; when it goes away (even after a crash) we must not linger.
    process.stdin.on('end', exit);
    process.stdin.resume();
  }
  return { hub, stop };
}
