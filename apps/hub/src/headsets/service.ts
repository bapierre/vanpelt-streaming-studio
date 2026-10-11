import {
  micSourceKey,
  obsSourceKey,
  type AudioState,
  type Envelope,
  type EventPayload,
  type HeadsetAdd,
  type HeadsetPatch,
  type HeadsetSendPatch,
  type HeadsetSource,
  type HeadsetsState,
  type HeadsetState,
  type KnownEventType,
  type SourceKey,
} from '@streamhub/shared';
import type { AudioObs } from '../audio/service';
import { micIdFor } from '../audio/config';
import { isNotFound } from '../cameras/obs-side';
import type { Bus } from '../bus/bus';
import { describeError } from '../util/errors';
import { realTimer, type Timer } from '../util/timer';
import type { HeadsetConfig, HeadsetsConfig } from './config';
import {
  AUDIO_MONITOR_KIND,
  dbToMonitorVolume,
  headsetFilterName,
  headsetIdOfFilter,
  isHeadsetFilter,
  monitorSettings,
} from './monitor';
import type { OutputList } from './outputs';

export type HeadsetServiceOptions = {
  bus: Bus;
  obs: AudioObs;
  config: HeadsetsConfig;
  save: (cfg: HeadsetsConfig) => Promise<void>;
  listOutputs: () => Promise<OutputList>;
  timer?: Timer;
  log?: (msg: string) => void;
};

/** The audio service's input for listing devices; never a real source. */
const PROBE_INPUT = 'streamhub device probe';
/** Volume changes smaller than this (in %) are not worth a request. */
const VOLUME_EPSILON = 0.01;
/** A slider drag saves once it pauses for this long, not on every tick. */
export const SAVE_DELAY_MS = 1000;

type Mic = { id: string; name: string; input: string; muted: boolean; ok: boolean };
/** What the hub last wrote to (or read from) one headset filter on one input. */
type Applied = { enabled: boolean; volume: number; device: string };
type ObsFilter = { filterName: string; filterKind: string; filterIndex: number; filterEnabled: boolean; filterSettings: Record<string, unknown> };

const filterKey = (input: string, headsetId: string) => `${input}\n${headsetId}`;
const splitKey = (key: string) => {
  const i = key.lastIndexOf('\n');
  return { input: key.slice(0, i), headsetId: key.slice(i + 1) };
};

/**
 * Per-person headset mixes: each source a headset hears gets one Audio Monitor filter on its OBS
 * input, playing to that headset's output device. All OBS work runs one step at a time.
 */
export class HeadsetService {
  private connected = false;
  private plugin: boolean | null = null;
  private mics: Mic[] = [];
  /** Every OBS input that carries audio, in OBS's order, with its mute state. */
  private audioInputs = new Map<string, { muted: boolean }>();
  private readonly applied = new Map<string, Applied>();
  private readonly reorderQueued = new Set<string>();
  private outputs: OutputList = { outputs: [] };
  /** system_profiler costs up to a few seconds, so it runs only once outputs are wanted. */
  private outputsScanned = false;
  private saveHandle: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private applyQueued = false;
  private published = '';
  private unsubscribe: (() => void) | null = null;
  private listening = false;
  private readonly log: (msg: string) => void;

  private readonly timer: Timer;

  constructor(private readonly opts: HeadsetServiceOptions) {
    this.log = opts.log ?? console.warn;
    this.timer = opts.timer ?? realTimer;
  }

  start() {
    this.listenToObs();
    const topics = ['obs.connection', 'audio.state', 'headsets.cmd.'];
    for (const e of this.opts.bus.retainedFor(topics)) this.onEvent(e);
    this.unsubscribe = this.opts.bus.subscribe(topics, (e) => this.onEvent(e));
    this.publish();
    if (this.headsets.length > 0) this.scanOutputs();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.saveHandle !== null) this.timer.clear(this.saveHandle);
    this.saveHandle = null;
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

  private get headsets() {
    return this.opts.config.headsets;
  }

  private run(what: string, fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((err) => {
      this.log(`[headsets] ${what} failed: ${describeError(err)}`);
    });
  }

  /** Coalesces bursts (a fader drag) into one pass that only sends what changed. */
  private scheduleApply() {
    if (this.applyQueued) return;
    this.applyQueued = true;
    this.run('apply', async () => {
      this.applyQueued = false;
      await this.apply();
    });
  }

  private emit<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    this.opts.bus.publish({ type, payload, source: 'headsets' });
  }

  // ---- state ----

  private sources(): HeadsetSource[] {
    const micInputs = new Set(this.mics.map((m) => m.input));
    const mics = this.mics.map((m): HeadsetSource => ({ key: micSourceKey(m.id), name: m.name, kind: 'mic' }));
    const others = [...this.audioInputs.keys()]
      .filter((name) => !micInputs.has(name) && name !== PROBE_INPUT)
      .map((name): HeadsetSource => ({ key: obsSourceKey(name), name, kind: 'obs' }));
    return [...mics, ...others];
  }

  /** The OBS input a source plays from, and whether it is muted; null when it cannot play right now. */
  private resolve(key: SourceKey): { input: string; muted: boolean } | null {
    if (key.startsWith('mic:')) {
      const mic = this.mics.find((m) => micSourceKey(m.id) === key);
      return mic?.ok ? { input: mic.input, muted: mic.muted } : null;
    }
    const input = key.slice('obs:'.length);
    const audio = this.audioInputs.get(input);
    return audio && !this.mics.some((m) => m.input === input) ? { input, muted: audio.muted } : null;
  }

  private status(): HeadsetState['status'] {
    if (!this.connected) return 'offline';
    return this.plugin === false ? 'no-plugin' : 'ok';
  }

  private detailFor(h: HeadsetConfig): string | undefined {
    if (!this.connected) return 'OBS is not connected';
    if (this.plugin === false) return 'Install the Audio Monitor plugin in OBS';
    if (this.outputs.outputs.length > 0 && !this.outputs.outputs.includes(h.device)) {
      return `"${h.device}" is not plugged in`;
    }
    return undefined;
  }

  private snapshot(): HeadsetsState {
    const status = this.status();
    return {
      plugin: this.plugin,
      outputs: this.outputs.outputs,
      ...(this.outputs.detail ? { outputsDetail: this.outputs.detail } : {}),
      sources: this.sources(),
      headsets: this.headsets.map((h) => {
        const detail = this.detailFor(h);
        return {
          id: h.id,
          name: h.name,
          device: h.device,
          owner: h.owner,
          masterDb: h.masterDb,
          muted: h.muted,
          status,
          ...(detail ? { detail } : {}),
          sends: h.sends,
        };
      }),
    };
  }

  private publish() {
    const state = this.snapshot();
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    this.emit('headsets.state', state);
  }

  private async saveConfig() {
    try {
      await this.opts.save(this.opts.config);
    } catch (err) {
      this.log(`[headsets] could not save the headset list: ${describeError(err)}`);
    }
  }

  /** Saves trail the last change by SAVE_DELAY_MS so a drag writes once, not on every tick. */
  private saveSoon() {
    if (this.saveHandle !== null) this.timer.clear(this.saveHandle);
    this.saveHandle = this.timer.set(() => {
      this.saveHandle = null;
      void this.saveConfig();
    }, SAVE_DELAY_MS);
  }

  /** Sources that appeared since a headset was set up join it switched on, at full level. */
  private fillSends(): boolean {
    let changed = false;
    for (const source of this.sources()) {
      for (const h of this.headsets) {
        if (h.sends[source.key]) continue;
        h.sends[source.key] = { on: true, db: 0 };
        changed = true;
      }
    }
    return changed;
  }

  /** Call after anything that changes the sources or the config: fills sends, saves, publishes, applies. */
  private changed(saveNeeded: boolean) {
    if (this.fillSends() || saveNeeded) this.saveSoon();
    this.publish();
    this.scheduleApply();
  }

  private scanOutputs() {
    this.run('list outputs', () => this.refreshOutputs());
  }

  // ---- bus ----

  private onEvent(e: Envelope) {
    switch (e.type) {
      case 'obs.connection': {
        const { connected } = e.payload as EventPayload<'obs.connection'>;
        if (connected === this.connected) return;
        this.connected = connected;
        // Whatever OBS had, it is re-read on the next connect.
        this.applied.clear();
        if (connected) this.run('refresh', () => this.refreshAll());
        this.publish();
        return;
      }
      case 'audio.state': {
        const { mics } = e.payload as AudioState;
        this.mics = mics.map((m) => ({ id: m.id, name: m.name, input: m.input, muted: m.muted, ok: m.status === 'ok' }));
        return this.changed(false);
      }
      case 'headsets.cmd.add':
        return this.add(e.payload as HeadsetAdd);
      case 'headsets.cmd.update':
        return this.update(e.payload as HeadsetPatch);
      case 'headsets.cmd.remove': {
        const { id } = e.payload as EventPayload<'headsets.cmd.remove'>;
        const before = this.headsets.length;
        this.opts.config.headsets = this.headsets.filter((h) => h.id !== id);
        if (this.headsets.length !== before) this.changed(true);
        return;
      }
      case 'headsets.cmd.setSend':
        return this.setSend(e.payload as HeadsetSendPatch);
      case 'headsets.cmd.listOutputs':
        return this.scanOutputs();
    }
  }

  private add(p: HeadsetAdd) {
    if (this.headsets.length >= 16) return this.log('[headsets] no more than 16 headsets');
    const id = micIdFor(p.name, new Set(this.headsets.map((h) => h.id)), 'headset');
    // Everyone hears every source by default, their own mic included (sidetone).
    const sends = Object.fromEntries(this.sources().map((s) => [s.key, { on: true, db: 0 }]));
    this.headsets.push({ id, name: p.name, device: p.device, owner: p.owner, masterDb: 0, muted: false, sends });
    // The add form wants the output list even when no headset existed at startup.
    if (!this.outputsScanned) this.scanOutputs();
    this.changed(true);
  }

  private update(p: HeadsetPatch) {
    const h = this.headsets.find((x) => x.id === p.id);
    if (!h) return;
    if (p.name !== undefined) h.name = p.name;
    if (p.device !== undefined) h.device = p.device;
    if (p.owner !== undefined) h.owner = p.owner;
    if (p.masterDb !== undefined) h.masterDb = p.masterDb;
    if (p.muted !== undefined) h.muted = p.muted;
    this.changed(true);
  }

  private setSend(p: HeadsetSendPatch) {
    const h = this.headsets.find((x) => x.id === p.id);
    if (!h) return;
    const send = h.sends[p.source] ?? { on: true, db: 0 };
    h.sends[p.source] = { on: p.on ?? send.on, db: p.db ?? send.db };
    this.changed(true);
  }

  // ---- OBS events ----

  private listenToObs() {
    if (this.listening) return;
    this.listening = true;
    const on = <T>(event: string, fn: (d: T) => void) => this.obs.onObs<T>(event, fn);
    on<{ inputName: string; inputMuted: boolean }>('InputMuteStateChanged', (d) => {
      const audio = this.audioInputs.get(d.inputName);
      if (!audio || audio.muted === d.inputMuted) return;
      audio.muted = d.inputMuted;
      this.scheduleApply();
    });
    on<{ inputName: string }>('InputCreated', (d) => {
      if (this.connected) this.run('new input', () => this.addInput(d.inputName));
    });
    on<{ inputName: string }>('InputRemoved', (d) => {
      if (!this.audioInputs.delete(d.inputName)) return;
      for (const key of [...this.applied.keys()]) if (splitKey(key).input === d.inputName) this.applied.delete(key);
      this.publish();
    });
    on<{ oldInputName: string; inputName: string }>('InputNameChanged', (d) => this.renameInput(d.oldInputName, d.inputName));
    on<{ sourceName: string; filterName: string }>('SourceFilterCreated', (d) => {
      if (isHeadsetFilter(d.filterName) || this.reorderQueued.has(d.sourceName)) return;
      if (![...this.applied.keys()].some((k) => splitKey(k).input === d.sourceName)) return;
      // A filter added after a headset's (e.g. a new mic's chain) would come after it; move the headset back to the end.
      this.reorderQueued.add(d.sourceName);
      this.run('filter order', async () => {
        this.reorderQueued.delete(d.sourceName);
        if (this.connected && this.audioInputs.has(d.sourceName)) await this.scanFilters(d.sourceName);
      });
    });
  }

  private renameInput(from: string, to: string) {
    const audio = this.audioInputs.get(from);
    if (!audio) return;
    // Keep OBS's order: rebuild the map with the new name in the old place.
    this.audioInputs = new Map([...this.audioInputs].map(([name, a]) => [name === from ? to : name, a]));
    for (const [key, a] of [...this.applied]) {
      const { input, headsetId } = splitKey(key);
      if (input !== from) continue;
      this.applied.delete(key);
      this.applied.set(filterKey(to, headsetId), a);
    }
    let moved = false;
    for (const h of this.headsets) {
      const send = h.sends[obsSourceKey(from)];
      if (!send) continue;
      delete h.sends[obsSourceKey(from)];
      h.sends[obsSourceKey(to)] = send;
      moved = true;
    }
    this.changed(moved);
  }

  // ---- OBS work (always inside run()) ----

  private async refreshOutputs() {
    this.outputs = await this.opts.listOutputs();
    this.outputsScanned = true;
    this.publish();
  }

  private async refreshAll() {
    if (!this.connected) return;
    this.plugin = await this.hasPlugin();
    const { inputs } = (await this.obs.call('GetInputList')) as { inputs: Array<{ inputName: string }> };
    this.audioInputs = new Map();
    for (const { inputName } of inputs) await this.addInput(inputName, false);
    if (this.fillSends()) await this.saveConfig();
    this.publish();
    await this.apply();
  }

  private async hasPlugin(): Promise<boolean | null> {
    try {
      const { sourceFilterKinds } = (await this.obs.call('GetSourceFilterKindList')) as { sourceFilterKinds: string[] };
      return sourceFilterKinds.includes(AUDIO_MONITOR_KIND);
    } catch (err) {
      // Older obs-websocket cannot list filter kinds: try anyway and let filter creation report problems.
      this.log(`[headsets] could not check for the Audio Monitor plugin: ${describeError(err)}`);
      return null;
    }
  }

  /** Records an input if it carries audio, and reads back any headset filters it already has. */
  private async addInput(name: string, follow = true) {
    if (!this.connected) return;
    let muted: boolean;
    try {
      ({ inputMuted: muted } = (await this.obs.call('GetInputMute', { inputName: name })) as { inputMuted: boolean });
    } catch {
      return; // No audio (an image, a scene source) or already gone.
    }
    this.audioInputs.set(name, { muted });
    await this.scanFilters(name);
    if (follow) this.changed(false);
  }

  private async scanFilters(input: string) {
    const { filters } = (await this.obs.call('GetSourceFilterList', { sourceName: input })) as { filters: ObsFilter[] };
    const known = new Set(this.headsets.map((h) => h.id));
    let lastOther = -1;
    for (const f of filters) if (!isHeadsetFilter(f.filterName)) lastOther = Math.max(lastOther, f.filterIndex);
    for (const f of filters) {
      if (!isHeadsetFilter(f.filterName) || f.filterKind !== AUDIO_MONITOR_KIND) continue;
      const id = headsetIdOfFilter(f.filterName);
      if (!known.has(id)) {
        // Left over from a headset that was removed while OBS was closed.
        await this.removeFilter(input, f.filterName);
        continue;
      }
      const s = f.filterSettings ?? {};
      this.applied.set(filterKey(input, id), {
        enabled: f.filterEnabled,
        volume: typeof s.volume === 'number' ? s.volume : 100,
        device: typeof s.deviceName === 'string' ? s.deviceName : '',
      });
      // Headsets hear the processed voice, so their filters stay after denoise, EQ and dynamics.
      if (f.filterIndex < lastOther) {
        await this.obs.call('SetSourceFilterIndex', { sourceName: input, filterName: f.filterName, filterIndex: filters.length - 1 });
      }
    }
  }

  private async removeFilter(input: string, filterName: string) {
    try {
      await this.obs.call('RemoveSourceFilter', { sourceName: input, filterName });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** Brings OBS in line with the config, touching only what differs from what was last written. */
  private async apply() {
    if (!this.connected || this.plugin === false) return;
    const desired = new Map<string, { input: string; headset: HeadsetConfig; enabled: boolean; volume: number }>();
    for (const source of this.sources()) {
      const from = this.resolve(source.key);
      if (!from) continue;
      for (const headset of this.headsets) {
        const send = headset.sends[source.key];
        if (!send) continue;
        desired.set(filterKey(from.input, headset.id), {
          input: from.input,
          headset,
          // The plugin plays whatever reaches it, OBS mute or not, so a muted source is switched off here.
          enabled: send.on && !headset.muted && !from.muted,
          volume: dbToMonitorVolume(send.db + headset.masterDb),
        });
      }
    }

    for (const [key, want] of desired) {
      const filterName = headsetFilterName(want.headset.id);
      const sourceName = want.input;
      const device = want.headset.device;
      try {
        const cur = this.applied.get(key);
        if (!cur) {
          if (!want.enabled) continue;
          await this.obs.call('CreateSourceFilter', {
            sourceName,
            filterName,
            filterKind: AUDIO_MONITOR_KIND,
            filterSettings: monitorSettings(device, want.volume),
          });
          this.applied.set(key, { enabled: true, volume: want.volume, device });
          continue;
        }
        const settings: Record<string, unknown> = {};
        // Writing the device makes the plugin reopen it (a dropout), so it is only sent when it changed.
        if (cur.device !== device) Object.assign(settings, { device, deviceName: device, mute: 0, linked: false });
        if (Math.abs(cur.volume - want.volume) > VOLUME_EPSILON) settings.volume = want.volume;
        if (Object.keys(settings).length > 0) {
          await this.obs.call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: settings, overlay: true });
          cur.device = device;
          cur.volume = want.volume;
        }
        if (cur.enabled !== want.enabled) {
          await this.obs.call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled: want.enabled });
          cur.enabled = want.enabled;
        }
      } catch (err) {
        this.applied.delete(key);
        this.log(`[headsets] could not set ${want.headset.name}'s mix on "${sourceName}": ${describeError(err)}`);
      }
    }

    for (const key of [...this.applied.keys()]) {
      if (desired.has(key)) continue;
      const { input, headsetId } = splitKey(key);
      this.applied.delete(key);
      // Otherwise the input itself went away and took the filter with it.
      if (!this.headsets.some((h) => h.id === headsetId) && this.audioInputs.has(input)) {
        try {
          await this.removeFilter(input, headsetFilterName(headsetId));
        } catch (err) {
          this.log(`[headsets] could not remove a headset filter from "${input}": ${describeError(err)}`);
        }
      }
    }
  }
}
