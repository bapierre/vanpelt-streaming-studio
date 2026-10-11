import {
  MIC_FILTER_ORDER,
  MicFilterSchemas,
  type AudioDevices,
  type AudioState,
  type Envelope,
  type EventPayload,
  type KnownEventType,
  type MicAdd,
  type MicFilterKey,
  type MicFilters,
  type MicPatch,
  type MicState,
  type Soundcheck,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { ObsCalls } from '../cameras/obs-side';
import { isHeadsetFilter } from '../headsets/monitor';
import { describeError } from '../util/errors';
import { realTimer, type Timer } from '../util/timer';
import { micIdFor, type AudioConfig, type MicConfig } from './config';
import {
  applyRouting,
  assignTracks,
  configureRecording,
  dbFromObs,
  ensureChain,
  FilterDefaults,
  FILTERS,
  initialFilters,
  isNotFound,
  levelFromMeters,
  MIC_INPUT_KINDS,
  MICS_SCENE,
  monitorFromObs,
  monitorToObs,
  readInputAudio,
  setFilterEnabled,
  tracksFor,
  writeFilter,
  type InputAudio,
  type Level,
} from './obs-audio';
import { SpeechMeter } from './soundcheck';

/** What the audio service needs from the OBS bridge. */
export type AudioObs = ObsCalls & { onObs<T>(event: string, listener: (data: T) => void): void };

export type AudioServiceOptions = {
  bus: Bus;
  obs: AudioObs;
  config: AudioConfig;
  save: (cfg: AudioConfig) => Promise<void>;
  timer?: Timer;
  now?: () => number;
  log?: (msg: string) => void;
};

/** Meter frames arrive about 20 times per second; the dashboard needs fewer. */
export const LEVELS_MS = 66;
export const DEFAULT_SOUNDCHECK_S = 10;
const DYNAMICS: MicFilterKey[] = ['gate', 'compressor', 'limiter'];
const PROBE_INPUT = 'streamhub device probe';

type Entry = {
  cfg: MicConfig;
  track: number | null;
  status: MicState['status'];
  detail?: string;
  audio: InputAudio;
  filters: MicFilters;
  soundcheck?: Soundcheck;
  refreshQueued?: boolean;
};

type Check = { id: string; meter: SpeechMeter; handle: unknown; restore: Partial<Record<MicFilterKey, boolean>> };

const RECORD_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';

const quietAudio = (): InputAudio => ({ volumeDb: 0, muted: false, monitor: 'off', syncOffsetMs: 0, live: false });

export class AudioService {
  private connected = false;
  private entries: Entry[] = [];
  /** Someone else starts and stops recordings; this only tracks whether one is running. */
  private recording = false;
  private recordTracks: number[] = [1];
  private recordDetail: string | undefined = 'OBS is not connected';
  /** Track names and picks changed while recording; OBS only reads them when a recording starts. */
  private recordingSetupPending = false;
  private devices: AudioDevices = { devices: [], inputs: [] };
  private check: Check | null = null;
  /** Dynamics a sound check switched off while OBS went away; switched back on at reconnect. */
  private readonly pendingRestore = new Map<string, Partial<Record<MicFilterKey, boolean>>>();
  private levels: Record<string, Level> = {};
  private lastLevelsAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private published = '';
  private unsubscribe: (() => void) | null = null;
  private listening = false;
  private micKind: string | null = null;
  private readonly defaults = new FilterDefaults();
  private readonly timer: Timer;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: AudioServiceOptions) {
    this.timer = opts.timer ?? realTimer;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
    this.rebuild();
  }

  start() {
    this.listenToObs();
    const topics = ['obs.connection', 'audio.cmd.'];
    for (const e of this.opts.bus.retainedFor(topics)) this.onEvent(e);
    this.unsubscribe = this.opts.bus.subscribe(topics, (e) => this.onEvent(e));
    this.publish();
    this.emit('audio.devices', this.devices);
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.check) this.timer.clear(this.check.handle);
    this.check = null;
  }

  /** Resolves once all queued OBS work has finished. */
  async idle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  private get obs() {
    return this.opts.obs;
  }

  private run(what: string, fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((err) => {
      this.log(`[audio] ${what} failed: ${describeError(err)}`);
    });
  }

  private emit<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    this.opts.bus.publish({ type, payload, source: 'audio' });
  }

  // ---- state ----

  /** Recomputes entries from config, keeping what is known about mics that stay. */
  private rebuild() {
    const old = new Map(this.entries.map((e) => [e.cfg.id, e]));
    const tracks = assignTracks(this.opts.config.mics.length);
    this.entries = this.opts.config.mics.map((cfg, i) => {
      const prev = old.get(cfg.id);
      return {
        cfg,
        track: tracks[i] ?? null,
        status: prev?.status ?? (this.connected ? 'ok' : 'offline'),
        detail: prev?.detail,
        audio: prev?.audio ?? quietAudio(),
        filters: prev?.filters ?? initialFilters(),
        soundcheck: prev?.soundcheck,
      };
    });
  }

  private snapshot(): AudioState {
    return {
      mics: this.entries.map((e) => ({
        id: e.cfg.id,
        name: e.cfg.name,
        input: e.cfg.input,
        channel: e.cfg.channel,
        track: e.track,
        status: e.status,
        ...(e.detail ? { detail: e.detail } : {}),
        ...e.audio,
        filters: e.filters,
        ...(e.soundcheck ? { soundcheck: e.soundcheck } : {}),
      })),
      targetDb: this.opts.config.targetDb,
      recordTracks: this.recordTracks,
      ...(this.recordDetail ? { recordDetail: this.recordDetail } : {}),
      tracksPending: this.recordingSetupPending,
    };
  }

  private publish() {
    const state = this.snapshot();
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    this.emit('audio.state', state);
  }

  private setDevices(d: Partial<AudioDevices>) {
    this.devices = { ...this.devices, ...d };
    if (!('detail' in d)) delete this.devices.detail;
    this.emit('audio.devices', this.devices);
  }

  private byInput(name: string | undefined) {
    return this.entries.find((e) => e.cfg.input === name);
  }

  private byId(id: string) {
    return this.entries.find((e) => e.cfg.id === id);
  }

  private async saveConfig() {
    try {
      await this.opts.save(this.opts.config);
    } catch (err) {
      this.log(`[audio] could not save the mic list: ${describeError(err)}`);
    }
  }

  // ---- bus ----

  private onEvent(e: Envelope) {
    switch (e.type) {
      case 'obs.connection': {
        const { connected } = e.payload as EventPayload<'obs.connection'>;
        if (connected === this.connected) return;
        this.connected = connected;
        if (connected) {
          this.defaults.clear();
          this.micKind = null;
          this.run('refresh', () => this.refreshAll());
        } else {
          this.onDisconnected();
        }
        return;
      }
      case 'audio.cmd.set':
        return this.run('change', () => this.applyPatch(e.payload as MicPatch));
      case 'audio.cmd.setTarget':
        this.opts.config.targetDb = (e.payload as EventPayload<'audio.cmd.setTarget'>).targetDb;
        this.publish();
        return void this.saveConfig();
      case 'audio.cmd.add':
        return this.run('add mic', () => this.addMic(e.payload as MicAdd));
      case 'audio.cmd.remove':
        return this.run('remove mic', () => this.removeMic((e.payload as EventPayload<'audio.cmd.remove'>).id));
      case 'audio.cmd.listDevices':
        return this.run('list devices', () => this.listDevices());
      case 'audio.cmd.nest':
        return this.run('add mics to scenes', () => this.nest((e.payload as EventPayload<'audio.cmd.nest'>).scene));
      case 'audio.cmd.soundcheck': {
        const p = e.payload as EventPayload<'audio.cmd.soundcheck'>;
        if (p.action === 'cancel') return this.cancelSoundcheck(p.id);
        return this.startSoundcheck(p.id, p.seconds ?? DEFAULT_SOUNDCHECK_S);
      }
    }
  }

  private onDisconnected() {
    if (this.check) {
      this.timer.clear(this.check.handle);
      this.pendingRestore.set(this.check.id, this.check.restore);
      const e = this.byId(this.check.id);
      if (e) e.soundcheck = { state: 'failed', detail: 'OBS disconnected during the sound check' };
      this.check = null;
    }
    for (const e of this.entries) {
      e.status = 'offline';
      e.detail = undefined;
      e.audio.live = false;
    }
    this.recordDetail = 'OBS is not connected';
    this.recording = false;
    this.publish();
  }

  // ---- OBS events ----

  private listenToObs() {
    if (this.listening) return;
    this.listening = true;
    const on = <T>(event: string, fn: (d: T) => void) => this.obs.onObs<T>(event, fn);
    const update = (name: string | undefined, fn: (e: Entry) => void) => {
      const e = this.byInput(name);
      if (!e || e.status !== 'ok') return;
      fn(e);
      this.publish();
    };
    on<{ inputName: string; inputVolumeDb: number }>('InputVolumeChanged', (d) =>
      update(d.inputName, (e) => (e.audio.volumeDb = dbFromObs(d.inputVolumeDb))),
    );
    on<{ inputName: string; inputMuted: boolean }>('InputMuteStateChanged', (d) =>
      update(d.inputName, (e) => (e.audio.muted = d.inputMuted)),
    );
    on<{ inputName: string; monitorType: string }>('InputAudioMonitorTypeChanged', (d) =>
      update(d.inputName, (e) => (e.audio.monitor = monitorFromObs(d.monitorType))),
    );
    on<{ inputName: string; inputAudioSyncOffset: number }>('InputAudioSyncOffsetChanged', (d) =>
      update(d.inputName, (e) => (e.audio.syncOffsetMs = d.inputAudioSyncOffset)),
    );
    on<{ inputName: string; videoActive: boolean }>('InputActiveStateChanged', (d) =>
      update(d.inputName, (e) => (e.audio.live = d.videoActive)),
    );
    for (const event of [
      'SourceFilterSettingsChanged',
      'SourceFilterEnableStateChanged',
      'SourceFilterCreated',
      'SourceFilterRemoved',
      'SourceFilterNameChanged',
    ]) {
      on<{ sourceName: string; filterName?: string }>(event, (d) => {
        // Headset sends live on the same inputs but are not part of the mic's chain.
        if (!isHeadsetFilter(d.filterName)) this.queueRefresh(this.byInput(d.sourceName));
      });
    }
    on<{ inputName: string }>('InputRemoved', (d) => {
      const e = this.byInput(d.inputName);
      if (!e) return;
      e.status = 'missing';
      e.detail = `No OBS input named "${e.cfg.input}"`;
      e.audio.live = false;
      this.publish();
    });
    on<{ inputName: string }>('InputCreated', (d) => {
      const e = this.byInput(d.inputName);
      if (e && e.status === 'missing') this.run('refresh mic', () => this.refreshMic(e, true));
    });
    on<{ oldInputName: string; inputName: string }>('InputNameChanged', (d) => {
      const e = this.byInput(d.oldInputName);
      if (!e) return;
      e.cfg.input = d.inputName;
      this.publish();
      void this.saveConfig();
    });
    on<{ outputState: string }>('RecordStateChanged', (d) => this.onRecordState(d.outputState));
    on<{ inputs: Array<{ inputName: string; inputLevelsMul: unknown }> }>('InputVolumeMeters', (d) => this.onMeters(d.inputs));
  }

  private queueRefresh(e: Entry | undefined) {
    if (!e || e.status !== 'ok' || e.refreshQueued) return;
    e.refreshQueued = true;
    this.run('refresh mic', async () => {
      e.refreshQueued = false;
      await this.refreshMic(e, false);
    });
  }

  private onRecordState(outputState: string) {
    this.recording = outputState !== RECORD_STOPPED;
    if (!this.recording && this.recordingSetupPending) this.run('recording tracks', () => this.setupRecording());
  }

  private onMeters(inputs: Array<{ inputName: string; inputLevelsMul: unknown }> | undefined) {
    if (!Array.isArray(inputs)) return;
    for (const input of inputs) {
      const e = this.byInput(input.inputName);
      if (!e) continue;
      const level = levelFromMeters(input.inputLevelsMul);
      if (!level) continue;
      if (this.check?.id === e.cfg.id) this.check.meter.add(level);
      const prev = this.levels[e.cfg.id];
      this.levels[e.cfg.id] = prev
        ? {
            peakDb: Math.max(prev.peakDb, level.peakDb),
            rmsDb: Math.max(prev.rmsDb, level.rmsDb),
            inputPeakDb: Math.max(prev.inputPeakDb, level.inputPeakDb),
          }
        : level;
    }
    const now = this.now();
    if (now - this.lastLevelsAt < LEVELS_MS) return;
    this.lastLevelsAt = now;
    const levels = Object.fromEntries(
      this.entries.map((e) => {
        const l = this.levels[e.cfg.id];
        return [e.cfg.id, { peakDb: round1(l?.peakDb ?? -100), rmsDb: round1(l?.rmsDb ?? -100) }];
      }),
    );
    this.levels = {};
    if (this.entries.length > 0) this.emit('audio.levels', { levels });
  }

  // ---- OBS work (always inside run()) ----

  private async refreshAll() {
    const names = await this.inputNames();
    for (const e of this.entries) {
      if (!names.has(e.cfg.input)) {
        e.status = 'missing';
        e.detail = `No OBS input named "${e.cfg.input}"`;
        continue;
      }
      await this.refreshMic(e, true);
    }
    await this.readRecordStatus();
    await this.setupRecording();
    this.publish();
  }

  private async inputNames(): Promise<Set<string>> {
    const { inputs } = (await this.obs.call('GetInputList')) as { inputs: Array<{ inputName: string }> };
    return new Set(inputs.map((i) => i.inputName));
  }

  private async refreshMic(e: Entry, route: boolean) {
    if (!this.connected) return;
    try {
      const restore = this.pendingRestore.get(e.cfg.id);
      if (restore) {
        for (const [k, enabled] of Object.entries(restore)) {
          if (enabled) await setFilterEnabled(this.obs, e.cfg.input, k as MicFilterKey, true);
        }
        this.pendingRestore.delete(e.cfg.id);
      }
      const chain = await ensureChain(this.obs, e.cfg.input, this.defaults);
      if (route) await applyRouting(this.obs, e.cfg.input, e.track, e.cfg.channel);
      e.audio = await readInputAudio(this.obs, e.cfg.input);
      e.filters = chain.filters;
      e.status = 'ok';
      e.detail = chain.unavailable.length
        ? `This OBS has no ${chain.unavailable.map((k) => FILTERS[k].name.replace('streamhub ', '')).join(', ')} filter`
        : undefined;
    } catch (err) {
      if (isNotFound(err)) {
        e.status = 'missing';
        e.detail = `No OBS input named "${e.cfg.input}"`;
      } else {
        e.detail = describeError(err);
      }
    }
    this.publish();
  }

  private async readRecordStatus() {
    const r = (await this.obs.call('GetRecordStatus')) as { outputActive: boolean };
    this.recording = r.outputActive;
  }

  private async setupRecording() {
    if (!this.connected) return;
    if (this.recording) {
      this.recordingSetupPending = true;
      return this.publish();
    }
    this.recordingSetupPending = false;
    const names = new Map<number, string>();
    for (const e of this.entries) if (e.track !== null) names.set(e.track, e.cfg.name);
    try {
      const r = await configureRecording(this.obs, names);
      this.recordTracks = r.tracks;
      this.recordDetail = r.detail;
    } catch (err) {
      this.recordDetail = `Could not set the recording tracks: ${describeError(err)}`;
    }
    this.publish();
  }

  private async applyPatch(p: MicPatch) {
    const e = this.byId(p.id);
    if (!e) return;
    if (p.name !== undefined && p.name !== e.cfg.name) {
      e.cfg.name = p.name;
      await this.saveConfig();
      if (e.track !== null) await this.setupRecording();
    }
    const obsChange =
      p.volumeDb !== undefined || p.muted !== undefined || p.monitor !== undefined || p.syncOffsetMs !== undefined || p.filters;
    if (obsChange && (!this.connected || e.status !== 'ok')) {
      e.detail = this.connected ? e.detail : 'OBS is not connected';
      return this.publish();
    }
    const input = e.cfg.input;
    try {
      if (p.volumeDb !== undefined) {
        await this.obs.call('SetInputVolume', { inputName: input, inputVolumeDb: p.volumeDb });
        e.audio.volumeDb = p.volumeDb;
      }
      if (p.muted !== undefined) {
        await this.obs.call('SetInputMute', { inputName: input, inputMuted: p.muted });
        e.audio.muted = p.muted;
      }
      if (p.monitor !== undefined) {
        await this.obs.call('SetInputAudioMonitorType', { inputName: input, monitorType: monitorToObs(p.monitor) });
        e.audio.monitor = p.monitor;
      }
      if (p.syncOffsetMs !== undefined) {
        await this.obs.call('SetInputAudioSyncOffset', { inputName: input, inputAudioSyncOffset: p.syncOffsetMs });
        e.audio.syncOffsetMs = p.syncOffsetMs;
      }
      for (const key of MIC_FILTER_ORDER) {
        const change = p.filters?.[key];
        if (!change) continue;
        const before = e.filters[key];
        const after = MicFilterSchemas[key].parse({ ...before, ...change }) as typeof before;
        // A sound check owns the dynamics until it ends; remember the wish and apply it then.
        if (this.check?.id === e.cfg.id && DYNAMICS.includes(key) && change.enabled !== undefined) {
          this.check.restore[key] = change.enabled;
          after.enabled = before.enabled;
        }
        await writeFilter(this.obs, input, key, before, after);
        (e.filters as Record<MicFilterKey, unknown>)[key] = after;
      }
    } catch (err) {
      e.detail = describeError(err);
    }
    this.publish();
  }

  // ---- sound check ----

  private startSoundcheck(id: string, seconds: number) {
    const e = this.byId(id);
    if (!e) return;
    const fail = (detail: string) => {
      e.soundcheck = { state: 'failed', detail };
      this.publish();
    };
    if (!this.connected || e.status !== 'ok') return fail('The mic is not available in OBS');
    if (e.audio.muted) return fail('Unmute the mic first');
    if (this.check) this.cancelSoundcheck(this.check.id);
    this.run('sound check', async () => {
      if (!this.connected || this.check) return;
      const restore: Check['restore'] = {};
      await this.obs.call('SetInputVolume', { inputName: e.cfg.input, inputVolumeDb: 0 });
      e.audio.volumeDb = 0;
      for (const k of DYNAMICS) {
        restore[k] = e.filters[k].enabled;
        if (e.filters[k].enabled) await setFilterEnabled(this.obs, e.cfg.input, k, false);
        e.filters[k].enabled = false;
      }
      const ms = seconds * 1000;
      const handle = this.timer.set(() => this.finishSoundcheck(id), ms);
      this.check = { id, meter: new SpeechMeter(), handle, restore };
      e.soundcheck = { state: 'listening', until: this.now() + ms };
      this.publish();
    });
  }

  private finishSoundcheck(id: string) {
    const c = this.check;
    if (!c || c.id !== id) return;
    this.check = null;
    const e = this.byId(id);
    if (!e) return;
    const result = c.meter.result(this.opts.config.targetDb, e.filters.gain.db);
    this.run('sound check', async () => {
      if (result.ok) {
        const after = { ...e.filters.gain, enabled: true, db: result.gainDb };
        await writeFilter(this.obs, e.cfg.input, 'gain', e.filters.gain, after);
        e.filters.gain = after;
        e.soundcheck = {
          state: 'done',
          measuredDb: result.measuredDb,
          gainDb: result.gainDb,
          ...(result.detail ? { detail: result.detail } : {}),
        };
      } else {
        e.soundcheck = {
          state: 'failed',
          detail: result.detail,
          ...(result.measuredDb !== undefined ? { measuredDb: result.measuredDb } : {}),
        };
      }
      await this.restoreDynamics(e, c.restore);
      this.publish();
    });
  }

  private cancelSoundcheck(id: string) {
    const c = this.check;
    if (!c || c.id !== id) return;
    this.timer.clear(c.handle);
    this.check = null;
    const e = this.byId(id);
    if (!e) return;
    e.soundcheck = undefined;
    this.run('cancel sound check', async () => {
      await this.restoreDynamics(e, c.restore);
      this.publish();
    });
  }

  private async restoreDynamics(e: Entry, restore: Check['restore']) {
    for (const [k, enabled] of Object.entries(restore) as Array<[MicFilterKey, boolean]>) {
      if (!enabled) continue;
      await setFilterEnabled(this.obs, e.cfg.input, k, true);
      e.filters[k].enabled = true;
    }
  }

  // ---- mics list ----

  private async inputKind(): Promise<string> {
    if (this.micKind) return this.micKind;
    const { inputKinds } = (await this.obs.call('GetInputKindList', { unversioned: false })) as { inputKinds: string[] };
    const kind = MIC_INPUT_KINDS.find((k) => inputKinds.includes(k));
    if (!kind) throw new Error('This OBS has no audio input capture');
    this.micKind = kind;
    return kind;
  }

  private async ensureMicsScene() {
    const { scenes } = (await this.obs.call('GetSceneList')) as { scenes: Array<{ sceneName: string }> };
    if (!scenes.some((s) => s.sceneName === MICS_SCENE)) await this.obs.call('CreateScene', { sceneName: MICS_SCENE });
  }

  private async listDevices() {
    if (!this.connected) return this.setDevices({ detail: 'OBS is not connected' });
    try {
      const kind = await this.inputKind();
      const { inputs } = (await this.obs.call('GetInputList')) as { inputs: Array<{ inputName: string; inputKind: string }> };
      const mics = new Set(this.entries.map((e) => e.cfg.input));
      const free = inputs.filter((i) => MIC_INPUT_KINDS.includes(i.inputKind) && !mics.has(i.inputName)).map((i) => i.inputName);
      // OBS lists devices through an existing input's properties, so borrow one or make a short-lived probe.
      let probe = inputs.find((i) => i.inputKind === kind)?.inputName;
      const temporary = !probe;
      if (!probe) {
        await this.ensureMicsScene();
        await this.obs.call('CreateInput', { sceneName: MICS_SCENE, inputName: PROBE_INPUT, inputKind: kind, sceneItemEnabled: false });
        probe = PROBE_INPUT;
      }
      try {
        const { propertyItems } = (await this.obs.call('GetInputPropertiesListPropertyItems', {
          inputName: probe,
          propertyName: 'device_id',
        })) as { propertyItems: Array<{ itemName: string; itemEnabled: boolean; itemValue: unknown }> };
        const devices = propertyItems
          .filter((d) => d.itemEnabled !== false && d.itemValue !== '' && d.itemValue !== null)
          .map((d) => ({ id: String(d.itemValue), name: d.itemName }));
        this.setDevices({ devices, inputs: free.filter((n) => n !== PROBE_INPUT) });
      } finally {
        if (temporary) await this.obs.call('RemoveInput', { inputName: PROBE_INPUT }).catch(() => {});
      }
    } catch (err) {
      this.setDevices({ detail: `Could not list audio devices: ${describeError(err)}` });
    }
  }

  private async addMic(p: MicAdd) {
    if (!this.connected) return this.setDevices({ detail: 'OBS is not connected' });
    try {
      const names = await this.inputNames();
      let input: string;
      if (p.from.kind === 'input') {
        input = p.from.input;
        if (!names.has(input)) throw new Error(`No OBS input named "${input}"`);
        if (this.byInput(input)) throw new Error(`"${input}" is already a mic`);
      } else {
        const kind = await this.inputKind();
        await this.ensureMicsScene();
        input = p.name;
        for (let i = 2; names.has(input); i++) input = `${p.name} ${i}`;
        await this.obs.call('CreateInput', {
          sceneName: MICS_SCENE,
          inputName: input,
          inputKind: kind,
          inputSettings: { device_id: p.from.device },
        });
      }
      const id = micIdFor(p.name, new Set(this.entries.map((e) => e.cfg.id)));
      this.opts.config.mics.push({ id, name: p.name, input, channel: p.channel });
      this.rebuild();
      await this.saveConfig();
      const e = this.byId(id)!;
      await this.refreshMic(e, true);
      await this.setupRecording();
      this.setDevices({
        inputs: this.devices.inputs.filter((n) => n !== input),
        ...(e.track === null ? { detail: `${p.name} is mixed into the stream but has no isolated track: OBS has six tracks.` } : {}),
      });
    } catch (err) {
      this.setDevices({ detail: `Could not add the mic: ${describeError(err)}` });
    }
    this.publish();
  }

  private async removeMic(id: string) {
    const e = this.byId(id);
    if (!e) return;
    if (this.check?.id === id) this.cancelSoundcheck(id);
    this.opts.config.mics = this.opts.config.mics.filter((m) => m.id !== id);
    this.rebuild();
    await this.saveConfig();
    if (this.connected) {
      // Its isolated track may now belong to another mic.
      await this.obs.call('SetInputAudioTracks', { inputName: e.cfg.input, inputAudioTracks: tracksFor(null) }).catch(() => {});
      for (const other of this.entries) if (other.status === 'ok') await this.refreshMic(other, true);
      await this.setupRecording();
    }
    this.publish();
  }

  private async nest(scene: string | undefined) {
    if (!this.connected) return this.setDevices({ detail: 'OBS is not connected' });
    try {
      await this.ensureMicsScene();
      const { scenes } = (await this.obs.call('GetSceneList')) as { scenes: Array<{ sceneName: string }> };
      const targets = scene ? [scene] : scenes.map((s) => s.sceneName).filter((s) => s !== MICS_SCENE);
      let added = 0;
      for (const sceneName of targets) {
        const { sceneItems } = (await this.obs.call('GetSceneItemList', { sceneName })) as {
          sceneItems: Array<{ sourceName: string }>;
        };
        if (sceneItems.some((i) => i.sourceName === MICS_SCENE)) continue;
        await this.obs.call('CreateSceneItem', { sceneName, sourceName: MICS_SCENE });
        added++;
      }
      this.setDevices({
        detail: added ? `Added the mics to ${added} scene${added === 1 ? '' : 's'}.` : 'Every scene already has the mics.',
      });
    } catch (err) {
      this.setDevices({ detail: `Could not add the mics to the scenes: ${describeError(err)}` });
    }
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
