import { readdir, stat, statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type {
  CameraDriverState,
  CameraRecording,
  CameraState,
  CardStatus,
  DiskSpace,
  Envelope,
  EventPayload,
  RecordedFile,
  RecordingOutput,
  RecordingSession,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { CameraConfig } from '../cameras/config';
import { isNotFound, type ObsCalls } from '../cameras/obs-side';
import { describeError } from '../util/errors';
import { realTimer, type Timer } from '../util/timer';

export type RecordingObs = ObsCalls & { onObs<T>(event: string, listener: (data: T) => void): void };

/** Disk access, so tests can fake it. */
export type RecordingFs = {
  freeBytes(dir: string): Promise<number>;
  /** Files directly in `dir`, with their last-modified time. */
  list(dir: string): Promise<Array<{ path: string; mtimeMs: number }>>;
};

export type RecordingServiceOptions = {
  bus: Bus;
  obs: RecordingObs;
  cameras: CameraConfig[];
  fs?: RecordingFs;
  timer?: Timer;
  now?: () => number;
  log?: (msg: string) => void;
};

export const ISO_FILTER = 'streamhub ISO';
export const ISO_FILTER_KIND = 'source_record_filter';
/** Source Record's "Recording" mode: the filter records whenever OBS's main recording runs. */
const RECORD_MODE_RECORDING = 3;
const RECORD_MODE_NONE = 0;

export const LOW_DISK_BYTES = 20 * 1024 ** 3;
export const CRITICAL_DISK_BYTES = 5 * 1024 ** 3;
const DISK_POLL_RECORDING_MS = 30_000;
const DISK_POLL_IDLE_MS = 5 * 60_000;
/** File times and our clock can disagree slightly; files touched this long before the start still count. */
const FILE_TIME_SLACK_MS = 5_000;

const OUTPUT_STATES: Record<string, RecordingOutput> = {
  OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
  OBS_WEBSOCKET_OUTPUT_STARTED: 'recording',
  OBS_WEBSOCKET_OUTPUT_PAUSED: 'paused',
  OBS_WEBSOCKET_OUTPUT_RESUMED: 'recording',
  OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
  OBS_WEBSOCKET_OUTPUT_STOPPED: 'stopped',
};

type IsoSetup = { status: 'ready' } | { status: 'no-plugin' | 'no-source' | 'error'; detail: string };

const wantsIso = (c: CameraConfig) => c.record === 'obs' || c.record === 'both';
const wantsCard = (c: CameraConfig) => c.record === 'card' || c.record === 'both';

export const nodeFs: RecordingFs = {
  async freeBytes(dir) {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  },
  async list(dir) {
    const names = await readdir(dir);
    const out: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(dir, name);
      const s = await stat(path).catch(() => null);
      if (s?.isFile()) out.push({ path, mtimeMs: s.mtimeMs });
    }
    return out;
  },
};

/**
 * Gives every camera its own video file whenever OBS records: a Source Record filter on the camera's
 * OBS source (OBS encodes it), and/or the camera's own card through its driver. It never starts or
 * stops OBS's recording itself; it follows whatever started it.
 */
export class RecordingService {
  private obsConnected = false;
  private output: RecordingOutput = 'stopped';
  private startedAt: number | undefined;
  private directory: string | undefined;
  private pluginInstalled: boolean | undefined;
  private readonly iso = new Map<string, IsoSetup>();
  private readonly cameraStates = new Map<string, CameraState>();
  private readonly driverCards = new Map<string, CameraDriverState['card']>();
  /** Cameras whose card was seen recording during the current session. */
  private readonly cardRecorded = new Set<string>();
  private disk: DiskSpace | undefined;
  private lastDiskSample: { at: number; free: number } | undefined;
  private lastSession: RecordingSession['lastSession'];
  private detail: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private diskTimer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private published: string | undefined;
  private readonly fs: RecordingFs;
  private readonly timer: Timer;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: RecordingServiceOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.timer = opts.timer ?? realTimer;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
  }

  start() {
    const topics = ['obs.connection', 'camera.state', 'camera.driver.state', 'recording.cmd.'];
    for (const e of this.opts.bus.retainedFor(topics)) this.onEvent(e);
    this.unsubscribe = this.opts.bus.subscribe(topics, (e) => this.onEvent(e));
    this.opts.obs.onObs<{ outputState: string; outputPath?: string | null }>('RecordStateChanged', (d) =>
      this.onRecordState(d.outputState, d.outputPath ?? undefined),
    );
    this.publish();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.diskTimer !== null) this.timer.clear(this.diskTimer);
    this.diskTimer = null;
  }

  /** Resolves once queued OBS and disk work has finished. */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.queue;
      await seen;
    } while (seen !== this.queue);
  }

  private enqueue(work: () => Promise<void>, what: string) {
    this.queue = this.queue
      .then(work)
      .catch((err) => this.log(`[recording] ${what} failed: ${describeError(err)}`))
      .then(() => this.publish());
  }

  private onEvent(e: Envelope) {
    switch (e.type) {
      case 'obs.connection': {
        const connected = (e.payload as EventPayload<'obs.connection'>).connected;
        if (connected === this.obsConnected) return;
        this.obsConnected = connected;
        if (connected) {
          this.enqueue(() => this.sync(), 'setup');
        } else {
          this.iso.clear();
          this.pluginInstalled = undefined;
          this.publish();
        }
        return;
      }
      case 'camera.state': {
        const p = e.payload as CameraState;
        this.cameraStates.set(p.id, p);
        this.publish();
        return;
      }
      case 'camera.driver.state': {
        const p = e.payload as CameraDriverState;
        const cfg = this.opts.cameras.find((c) => c.id === p.id);
        if (!cfg || e.source !== `driver:${cfg.driver}`) return;
        this.driverCards.set(p.id, p.card);
        if (p.card?.recording && this.output !== 'stopped') this.cardRecorded.add(p.id);
        this.publish();
        return;
      }
      case 'recording.cmd.start':
        return this.command('StartRecord');
      case 'recording.cmd.stop':
        return this.command('StopRecord');
    }
  }

  /** OBS's own RecordStateChanged reports the outcome, so a success needs no further work here. */
  private command(request: 'StartRecord' | 'StopRecord') {
    if (!this.obsConnected) return this.log(`[recording] ignoring ${request}: OBS is not connected`);
    this.enqueue(async () => {
      try {
        await this.opts.obs.call(request);
        this.detail = undefined;
      } catch (err) {
        this.detail = `${request === 'StartRecord' ? 'Could not start' : 'Could not stop'} recording: ${describeError(err)}`;
        throw err;
      }
    }, request);
  }

  private async sync() {
    const { obs } = this.opts;
    const dir = (await obs.call('GetRecordDirectory')) as { recordDirectory: string };
    this.directory = dir.recordDirectory;
    try {
      const kinds = (await obs.call('GetSourceFilterKindList')) as { sourceFilterKinds: string[] };
      this.pluginInstalled = kinds.sourceFilterKinds.includes(ISO_FILTER_KIND);
    } catch {
      // Older obs-websocket has no kind list; find out when creating the filter instead.
      this.pluginInstalled = undefined;
    }
    for (const cfg of this.opts.cameras) {
      this.iso.set(cfg.id, await this.setupIso(cfg));
    }
    const status = (await obs.call('GetRecordStatus')) as {
      outputActive: boolean;
      outputPaused: boolean;
      outputDuration: number;
    };
    if (status.outputActive) {
      this.output = status.outputPaused ? 'paused' : 'recording';
      this.startedAt ??= this.now() - status.outputDuration;
    } else {
      this.output = 'stopped';
      this.startedAt = undefined;
    }
    await this.checkDisk();
  }

  private desiredSettings(cfg: CameraConfig) {
    return {
      record_mode: RECORD_MODE_RECORDING,
      path: this.directory,
      // OBS filename specifiers; the camera id at the end is how we find the file afterwards.
      filename_formatting: `%CCYY-%MM-%DD %hh-%mm-%ss ${cfg.id}`,
    };
  }

  private async setupIso(cfg: CameraConfig): Promise<IsoSetup> {
    const { obs } = this.opts;
    const ref = { sourceName: cfg.source, filterName: ISO_FILTER };
    let existing: { filterEnabled: boolean } | null = null;
    try {
      existing = (await obs.call('GetSourceFilter', ref)) as { filterEnabled: boolean };
    } catch (err) {
      if (!isNotFound(err)) return { status: 'error', detail: `OBS: ${describeError(err)}` };
    }
    try {
      if (!wantsIso(cfg)) {
        // A camera switched away from OBS recording must stop writing files.
        if (existing) {
          await obs.call('SetSourceFilterSettings', { ...ref, filterSettings: { record_mode: RECORD_MODE_NONE }, overlay: true });
        }
        return { status: 'ready' };
      }
      if (this.pluginInstalled === false) return noPlugin();
      if (existing) {
        await obs.call('SetSourceFilterSettings', { ...ref, filterSettings: this.desiredSettings(cfg), overlay: true });
        if (!existing.filterEnabled) await obs.call('SetSourceFilterEnabled', { ...ref, filterEnabled: true });
      } else {
        await obs.call('CreateSourceFilter', { ...ref, filterKind: ISO_FILTER_KIND, filterSettings: this.desiredSettings(cfg) });
      }
      return { status: 'ready' };
    } catch (err) {
      if (isNotFound(err)) return { status: 'no-source', detail: `OBS source "${cfg.source}" not found` };
      if (this.pluginInstalled === undefined && /filter kind/i.test(describeError(err))) return noPlugin();
      return { status: 'error', detail: `OBS: ${describeError(err)}` };
    }
  }

  private onRecordState(outputState: string, outputPath: string | undefined) {
    const next = OUTPUT_STATES[outputState];
    if (!next) return;
    const prev = this.output;
    this.output = next;
    if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
      this.startedAt = this.now();
      this.cardRecorded.clear();
      this.lastDiskSample = undefined;
      this.setCards(true);
      this.scheduleDisk(0);
    } else if (next === 'stopped' && prev !== 'stopped') {
      const sessionStart = this.startedAt;
      this.startedAt = undefined;
      this.setCards(false);
      this.enqueue(() => this.collectFiles(sessionStart, outputPath), 'collecting files');
      this.scheduleDisk(0);
      return;
    }
    this.publish();
  }

  private setCards(on: boolean) {
    for (const cfg of this.opts.cameras) {
      if (!wantsCard(cfg) || !cfg.driver) continue;
      if (on && this.cardStatus(cfg).status === 'recording') this.cardRecorded.add(cfg.id);
      this.opts.bus.publish({ type: 'camera.driver.cmd.record', payload: { id: cfg.id, on }, source: 'hub' });
    }
  }

  private async collectFiles(sessionStart: number | undefined, programPath: string | undefined) {
    const files: RecordedFile[] = [];
    this.detail = undefined;
    if (programPath) files.push({ kind: 'program', label: 'Program (stream mix + mic tracks)', location: programPath });
    const isoCameras = this.opts.cameras.filter((c) => wantsIso(c) && this.iso.get(c.id)?.status === 'ready');
    if (this.directory && isoCameras.length > 0) {
      const since = (sessionStart ?? 0) - FILE_TIME_SLACK_MS;
      const listed = await this.fs.list(this.directory).catch((err) => {
        this.detail = `Cannot read ${this.directory}: ${describeError(err)}`;
        return [];
      });
      for (const cfg of isoCameras) {
        const found = listed
          .filter((f) => f.mtimeMs >= since && basename(f.path, extname(f.path)).endsWith(` ${cfg.id}`))
          .sort((a, b) => a.path.localeCompare(b.path));
        for (const f of found) files.push({ kind: 'camera', cameraId: cfg.id, label: cfg.name, location: f.path });
      }
    }
    for (const cfg of this.opts.cameras) {
      if (this.cardRecorded.has(cfg.id)) {
        files.push({ kind: 'card', cameraId: cfg.id, label: `${cfg.name} (card)`, location: `On ${cfg.name}'s card` });
      }
    }
    this.lastSession = { endedAt: this.now(), files };
  }

  private scheduleDisk(ms: number) {
    if (this.diskTimer !== null) this.timer.clear(this.diskTimer);
    this.diskTimer = this.timer.set(() => {
      this.diskTimer = null;
      this.enqueue(() => this.checkDisk(), 'disk check');
    }, ms);
  }

  private async checkDisk() {
    const recording = this.output !== 'stopped';
    this.scheduleDisk(recording ? DISK_POLL_RECORDING_MS : DISK_POLL_IDLE_MS);
    if (!this.directory) return;
    let free: number;
    try {
      free = await this.fs.freeBytes(this.directory);
    } catch (err) {
      // OBS may run on another machine; then the folder is not ours to measure.
      this.disk = undefined;
      this.log(`[recording] cannot read free space of ${this.directory}: ${describeError(err)}`);
      return;
    }
    const at = this.now();
    let minutesLeft: number | undefined;
    const prev = this.lastDiskSample;
    if (recording && prev && at > prev.at && prev.free > free) {
      const bytesPerMs = (prev.free - free) / (at - prev.at);
      minutesLeft = Math.floor(free / bytesPerMs / 60_000);
    }
    this.lastDiskSample = recording ? { at, free } : undefined;
    const level = free < CRITICAL_DISK_BYTES ? 'critical' : free < LOW_DISK_BYTES ? 'low' : 'ok';
    this.disk = { path: this.directory, freeBytes: free, level, ...(minutesLeft !== undefined ? { minutesLeft } : {}) };
  }

  private cardStatus(cfg: CameraConfig): { status: CardStatus; detail?: string } {
    if (!cfg.driver) return { status: 'unsupported', detail: 'This camera has no driver, so it cannot record to a card' };
    const cam = this.cameraStates.get(cfg.id);
    if (!cam || (cam.status !== 'ready' && cam.status !== 'streaming')) return { status: 'offline' };
    const card = this.driverCards.get(cfg.id);
    if (!card?.supported) return { status: 'unsupported', detail: `Driver "${cfg.driver}" cannot record to a card` };
    if (card.detail) return { status: card.recording ? 'recording' : 'error', detail: card.detail };
    return { status: card.recording ? 'recording' : 'ready' };
  }

  private camera(cfg: CameraConfig): CameraRecording {
    const out: CameraRecording = { id: cfg.id, name: cfg.name, mode: cfg.record };
    const details: string[] = [];
    if (wantsIso(cfg)) {
      const setup = this.obsConnected ? this.iso.get(cfg.id) : undefined;
      if (!setup) out.iso = 'offline';
      else if (setup.status !== 'ready') {
        out.iso = setup.status;
        details.push(setup.detail);
      } else out.iso = this.output === 'recording' || this.output === 'paused' ? 'recording' : 'ready';
    }
    if (wantsCard(cfg)) {
      const c = this.cardStatus(cfg);
      out.card = c.status;
      if (c.detail) details.push(c.detail);
    }
    if (details.length > 0) out.detail = details.join(' · ');
    return out;
  }

  private publish() {
    const payload: RecordingSession = {
      output: this.obsConnected ? this.output : 'stopped',
      ...(this.obsConnected && this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.directory ? { directory: this.directory } : {}),
      cameras: this.opts.cameras.map((c) => this.camera(c)),
      ...(this.disk ? { disk: this.disk } : {}),
      ...(this.lastSession ? { lastSession: this.lastSession } : {}),
      ...(this.detail ? { detail: this.detail } : !this.obsConnected ? { detail: 'OBS is not connected' } : {}),
    };
    const text = JSON.stringify(payload);
    if (text === this.published) return;
    this.published = text;
    const r = this.opts.bus.publish({ type: 'recording.state', payload, source: 'hub' });
    if (!r.ok) this.log(`[recording] invalid state: ${r.error}`);
  }
}

function noPlugin(): IsoSetup {
  return {
    status: 'no-plugin',
    detail: 'Install the OBS "Source Record" plugin to record each camera to its own file (see docs/setup/recording.md)',
  };
}
