import type {
  CameraControl,
  CameraDriverState,
  CameraState,
  ControlValue,
  Envelope,
  EventPayload,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import { describeError } from '../util/errors';
import type { CameraConfig } from './config';
import { applyObsControl, isNotFound, isObsSideKey, obsControls, readObsSide, type ObsCalls, type ObsSide } from './obs-side';

export type CameraServiceOptions = {
  bus: Bus;
  obs: ObsCalls;
  cameras: CameraConfig[];
  installedDrivers: ReadonlySet<string>;
  log?: (msg: string) => void;
};

type Entry = {
  cfg: CameraConfig;
  driver?: CameraDriverState;
  driverDown?: string;
  side?: ObsSide;
  obsDetail?: string;
  queue: Promise<void>;
  published?: string;
  /** OBS-side controls waiting for the queued write; a slider drag merges into one entry per key. */
  pendingObs?: Map<string, ControlValue>;
};

export class CameraService {
  private obsConnected = false;
  private scenes: string[] = [];
  private current = '';
  private readonly entries = new Map<string, Entry>();
  private unsubscribe: (() => void) | null = null;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: CameraServiceOptions) {
    this.log = opts.log ?? console.warn;
    for (const cfg of opts.cameras) {
      const missing = cfg.driver && !opts.installedDrivers.has(cfg.driver);
      this.entries.set(cfg.id, {
        cfg,
        queue: Promise.resolve(),
        obsDetail: 'OBS is not connected',
        driverDown: missing ? `Driver "${cfg.driver}" is not installed in modules/` : undefined,
      });
    }
  }

  start() {
    const topics = ['obs.connection', 'obs.scenes.list', 'obs.scene.changed', 'camera.cmd.', 'camera.driver.state'];
    for (const e of this.opts.bus.retainedFor(topics)) this.onEvent(e);
    this.unsubscribe = this.opts.bus.subscribe(topics, (e) => this.onEvent(e));
    this.entries.forEach((e) => this.publish(e));
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once all queued OBS work has finished. */
  async idle(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.queue));
  }

  /** Called by the driver host when a driver process is gone. */
  driverExited(driverId: string, detail: string) {
    for (const e of this.entries.values()) {
      if (e.cfg.driver !== driverId) continue;
      e.driver = undefined;
      e.driverDown = detail;
      this.publish(e);
    }
  }

  private onEvent(e: Envelope) {
    switch (e.type) {
      case 'obs.connection': {
        this.obsConnected = (e.payload as EventPayload<'obs.connection'>).connected;
        if (!this.obsConnected) {
          this.entries.forEach((entry) => {
            entry.side = undefined;
            entry.obsDetail = 'OBS is not connected';
            this.publish(entry);
          });
        }
        return;
      }
      case 'obs.scenes.list': {
        const p = e.payload as EventPayload<'obs.scenes.list'>;
        this.scenes = p.scenes;
        this.current = p.current;
        this.entries.forEach((entry) => this.enqueue(entry, () => this.refresh(entry)));
        return;
      }
      case 'obs.scene.changed':
        this.current = (e.payload as EventPayload<'obs.scene.changed'>).scene;
        this.entries.forEach((entry) => this.publish(entry));
        return;
      case 'camera.driver.state': {
        const p = e.payload as CameraDriverState;
        const entry = this.entries.get(p.id);
        if (!entry || e.source !== `driver:${entry.cfg.driver}`) return;
        entry.driver = p;
        entry.driverDown = undefined;
        this.publish(entry);
        return;
      }
      case 'camera.cmd.take':
        return this.take((e.payload as EventPayload<'camera.cmd.take'>).id);
      case 'camera.cmd.set': {
        const p = e.payload as EventPayload<'camera.cmd.set'>;
        return this.set(p.id, p.key, p.value);
      }
    }
  }

  private take(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return this.log(`[cameras] take: unknown camera ${id}`);
    if (!this.obsConnected || !this.scenes.includes(entry.cfg.scene)) {
      return this.log(`[cameras] take ${id}: ${entry.obsDetail ?? 'scene unavailable'}`);
    }
    this.opts.bus.publish({ type: 'obs.cmd.setScene', payload: { scene: entry.cfg.scene }, source: 'hub' });
  }

  private set(id: string, key: string, value: ControlValue) {
    const entry = this.entries.get(id);
    if (!entry) return this.log(`[cameras] set: unknown camera ${id}`);
    if (key === 'obs.createScene') return this.enqueue(entry, () => this.createScene(entry));
    if (isObsSideKey(key)) {
      // A slider drag outruns OBS writes; only the latest value per key is worth sending.
      const pending = (entry.pendingObs ??= new Map());
      const first = pending.size === 0;
      pending.set(key, value);
      if (!first) return;
      this.enqueue(
        entry,
        async () => {
          for (;;) {
            const next = pending.entries().next().value as [string, ControlValue] | undefined;
            if (!next) break;
            const [k, v] = next;
            pending.delete(k);
            if (!entry.side) throw new Error(entry.obsDetail ?? 'OBS source unavailable');
            try {
              entry.side = await applyObsControl(this.opts.obs, entry.cfg, entry.side, k, v);
            } catch (err) {
              pending.clear(); // superseded by whatever OBS holds now
              await this.refresh(entry);
              throw err;
            }
          }
        },
        `${key} on ${id}`,
      );
      return;
    }
    if (key.startsWith('obs.')) return this.log(`[cameras] unknown control ${key}`);
    if (!entry.cfg.driver || entry.driverDown) {
      return this.log(`[cameras] ${id} has no running driver for ${key}`);
    }
    this.opts.bus.publish({ type: 'camera.driver.cmd.set', payload: { id, key, value }, source: 'hub' });
  }

  private async refresh(entry: Entry) {
    const { scene, source } = entry.cfg;
    entry.side = undefined;
    if (!this.obsConnected) {
      entry.obsDetail = 'OBS is not connected';
    } else if (!this.scenes.includes(scene)) {
      entry.obsDetail = `Scene "${scene}" not found in OBS`;
    } else {
      try {
        entry.side = await readObsSide(this.opts.obs, entry.cfg);
        entry.obsDetail = undefined;
      } catch (err) {
        entry.obsDetail = isNotFound(err)
          ? `Source "${source}" is not in scene "${scene}"`
          : `OBS: ${describeError(err)}`;
      }
    }
  }

  private async createScene(entry: Entry) {
    const input = entry.driver?.obsInput;
    if (!input) throw new Error('this camera has no OBS source recipe');
    const { obs } = this.opts;
    const { scene, source } = entry.cfg;
    if (!this.scenes.includes(scene)) {
      await obs.call('CreateScene', { sceneName: scene });
      this.scenes = [...this.scenes, scene];
    }
    const { inputs } = (await obs.call('GetInputList')) as { inputs: Array<{ inputName: string }> };
    if (inputs.some((i) => i.inputName === source)) {
      await obs.call('CreateSceneItem', { sceneName: scene, sourceName: source });
    } else {
      await obs.call('CreateInput', {
        sceneName: scene,
        inputName: source,
        inputKind: input.kind,
        inputSettings: input.settings,
      });
    }
    await this.refresh(entry);
  }

  private enqueue(entry: Entry, work: () => Promise<void>, what = entry.cfg.id) {
    entry.queue = entry.queue
      .then(work)
      .catch((err) => this.log(`[cameras] ${what} failed: ${describeError(err)}`))
      .then(() => this.publish(entry));
  }

  private state(e: Entry): CameraState {
    const { cfg } = e;
    const status = cfg.driver
      ? e.driverDown
        ? 'error'
        : (e.driver?.status ?? 'connecting')
      : e.side
        ? 'ready'
        : this.obsConnected
          ? 'error'
          : 'disconnected';
    const controls: CameraControl[] = [
      ...(e.driverDown ? [] : (e.driver?.controls ?? [])),
      ...(e.side ? obsControls(e.side) : []),
    ];
    if (!e.side && this.obsConnected && e.driver?.obsInput) {
      controls.push({
        key: 'obs.createScene',
        label: 'Create OBS scene',
        kind: 'action',
        hint: `Adds scene "${cfg.scene}" with source "${cfg.source}"`,
      });
    }
    return {
      id: cfg.id,
      name: cfg.name,
      driver: cfg.driver,
      status,
      detail: e.driverDown ?? e.driver?.detail,
      obsDetail: e.obsDetail,
      scene: cfg.scene,
      onAir: this.obsConnected && this.current === cfg.scene,
      telemetry: e.driverDown ? undefined : e.driver?.telemetry,
      controls,
    };
  }

  private publish(entry: Entry) {
    const payload = this.state(entry);
    const text = JSON.stringify(payload);
    if (text === entry.published) return;
    entry.published = text;
    const r = this.opts.bus.publish({ type: 'camera.state', payload, source: 'hub' });
    if (!r.ok) this.log(`[cameras] invalid state for ${entry.cfg.id}: ${r.error}`);
  }
}
