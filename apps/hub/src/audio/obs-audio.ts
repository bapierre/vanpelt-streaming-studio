import {
  ISOLATED_TRACKS,
  MIC_FILTER_ORDER,
  MIX_TRACK,
  MicFilterSchemas,
  type MicChannel,
  type MicFilterKey,
  type MicFilters,
  type Monitor,
} from '@streamhub/shared';
import type { ObsCalls } from '../cameras/obs-side';
import { isNotFound } from '../cameras/obs-side';

export { isNotFound };

/** Inputs OBS uses for microphones and line-ins, per platform. */
export const MIC_INPUT_KINDS = ['coreaudio_input_capture', 'wasapi_input_capture', 'pulse_input_capture', 'alsa_input_capture'];
export const MICS_SCENE = 'streamhub mics';

type Settings = Record<string, unknown>;
type FilterDef<K extends MicFilterKey> = {
  name: string;
  kind: string;
  /** Used when the hub creates the filter: a sensible starting point for a voice. */
  initial: MicFilters[K];
  toObs(v: MicFilters[K]): Settings;
  /** `s` is OBS's defaults overlaid with the filter's saved settings. */
  fromObs(s: Settings, enabled: boolean): MicFilters[K];
};

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export const FILTERS: { [K in MicFilterKey]: FilterDef<K> } = {
  gain: {
    name: 'streamhub gain',
    kind: 'gain_filter',
    initial: { enabled: true, db: 0 },
    toObs: (v) => ({ db: v.db }),
    fromObs: (s, enabled) => ({ enabled, db: num(s.db, 0) }),
  },
  denoise: {
    name: 'streamhub noise suppression',
    kind: 'noise_suppress_filter_v2',
    initial: { enabled: true, method: 'rnnoise', suppressDb: -30 },
    toObs: (v) => ({ method: v.method, suppress_level: v.suppressDb }),
    fromObs: (s, enabled) => ({
      enabled,
      method: s.method === 'speex' ? 'speex' : 'rnnoise',
      suppressDb: num(s.suppress_level, -30),
    }),
  },
  gate: {
    name: 'streamhub gate',
    kind: 'noise_gate_filter',
    initial: { enabled: false, openDb: -26, closeDb: -32, attackMs: 25, holdMs: 200, releaseMs: 150 },
    toObs: (v) => ({
      open_threshold: v.openDb,
      close_threshold: v.closeDb,
      attack_time: v.attackMs,
      hold_time: v.holdMs,
      release_time: v.releaseMs,
    }),
    fromObs: (s, enabled) => ({
      enabled,
      openDb: num(s.open_threshold, -26),
      closeDb: num(s.close_threshold, -32),
      attackMs: num(s.attack_time, 25),
      holdMs: num(s.hold_time, 200),
      releaseMs: num(s.release_time, 150),
    }),
  },
  eq: {
    name: 'streamhub eq',
    kind: 'basic_eq_filter',
    initial: { enabled: false, low: 0, mid: 0, high: 0 },
    toObs: (v) => ({ low: v.low, mid: v.mid, high: v.high }),
    fromObs: (s, enabled) => ({ enabled, low: num(s.low, 0), mid: num(s.mid, 0), high: num(s.high, 0) }),
  },
  compressor: {
    name: 'streamhub compressor',
    kind: 'compressor_filter',
    initial: { enabled: true, ratio: 4, thresholdDb: -18, attackMs: 6, releaseMs: 60, outputDb: 0 },
    toObs: (v) => ({
      ratio: v.ratio,
      threshold: v.thresholdDb,
      attack_time: v.attackMs,
      release_time: v.releaseMs,
      output_gain: v.outputDb,
    }),
    fromObs: (s, enabled) => ({
      enabled,
      ratio: num(s.ratio, 10),
      thresholdDb: num(s.threshold, -18),
      attackMs: num(s.attack_time, 6),
      releaseMs: num(s.release_time, 60),
      outputDb: num(s.output_gain, 0),
    }),
  },
  limiter: {
    name: 'streamhub limiter',
    kind: 'limiter_filter',
    initial: { enabled: true, thresholdDb: -3, releaseMs: 60 },
    toObs: (v) => ({ threshold: v.thresholdDb, release_time: v.releaseMs }),
    fromObs: (s, enabled) => ({ enabled, thresholdDb: num(s.threshold, -6), releaseMs: num(s.release_time, 60) }),
  },
};

export const initialFilters = (): MicFilters =>
  Object.fromEntries(MIC_FILTER_ORDER.map((k) => [k, { ...FILTERS[k].initial }])) as MicFilters;

/** The chain filter with this OBS name, or null for filters the chain does not own. */
export const chainFilterKey = (name: string | undefined): MicFilterKey | null =>
  MIC_FILTER_ORDER.find((k) => FILTERS[k].name === name) ?? null;

/**
 * Applies a filter change echoed by OBS (SourceFilterSettingsChanged / ...EnableStateChanged)
 * straight into local state, so an echo does not need a full readback of the chain.
 */
export function readFilterSettings<K extends MicFilterKey>(
  filters: MicFilters,
  key: K,
  settings: Record<string, unknown>,
  enabled?: boolean,
): MicFilters {
  const def: FilterDef<K> = FILTERS[key];
  return { ...filters, [key]: def.fromObs({ ...def.toObs(filters[key]), ...settings }, enabled ?? filters[key].enabled) };
}

/** Values outside the OBS ranges (e.g. a hand-edited filter) are clamped so the state stays valid. */
function clampToSchema<K extends MicFilterKey>(key: K, v: MicFilters[K]): MicFilters[K] {
  const shape = MicFilterSchemas[key].shape as Record<string, { minValue?: number | null; maxValue?: number | null }>;
  const out: Record<string, unknown> = { ...v };
  for (const [field, value] of Object.entries(v)) {
    if (typeof value !== 'number') continue;
    const { minValue, maxValue } = shape[field] ?? {};
    let n = value;
    if (typeof minValue === 'number') n = Math.max(minValue, n);
    if (typeof maxValue === 'number') n = Math.min(maxValue, n);
    out[field] = n;
  }
  return out as MicFilters[K];
}

type ObsFilter = { filterName: string; filterKind: string; filterIndex: number; filterEnabled: boolean; filterSettings: Settings };

/** OBS only saves settings that differ from a filter's defaults, so readback needs the defaults too. */
export class FilterDefaults {
  private readonly cache = new Map<string, Settings>();
  async get(obs: ObsCalls, kind: string): Promise<Settings> {
    const hit = this.cache.get(kind);
    if (hit) return hit;
    let defaults: Settings = {};
    try {
      const r = (await obs.call('GetSourceFilterDefaultSettings', { filterKind: kind })) as { defaultFilterSettings: Settings };
      defaults = r.defaultFilterSettings ?? {};
    } catch {
      // Unknown kind or older OBS: fall back to the defaults built into fromObs.
    }
    this.cache.set(kind, defaults);
    return defaults;
  }
  clear() {
    this.cache.clear();
  }
}

export type ChainResult = { filters: MicFilters; unavailable: MicFilterKey[] };

/** Creates any missing streamhub filters on the input (in chain order) and reads all of them back. */
export async function ensureChain(obs: ObsCalls, input: string, defaults: FilterDefaults): Promise<ChainResult> {
  let list = await listFilters(obs, input);
  const unavailable: MicFilterKey[] = [];
  let created = false;
  for (const key of MIC_FILTER_ORDER) {
    const def = FILTERS[key];
    if (list.some((f) => f.filterName === def.name)) continue;
    try {
      await obs.call('CreateSourceFilter', {
        sourceName: input,
        filterName: def.name,
        filterKind: def.kind,
        filterSettings: def.toObs(def.initial as never),
      });
      if (!def.initial.enabled) {
        await obs.call('SetSourceFilterEnabled', { sourceName: input, filterName: def.name, filterEnabled: false });
      }
      created = true;
    } catch {
      unavailable.push(key);
    }
  }
  if (created) {
    list = await listFilters(obs, input);
    await orderChain(obs, input, list);
    list = await listFilters(obs, input);
  }
  const filters = initialFilters();
  for (const key of MIC_FILTER_ORDER) {
    const def = FILTERS[key];
    const f = list.find((x) => x.filterName === def.name);
    if (!f) {
      (filters[key] as { enabled: boolean }).enabled = false;
      continue;
    }
    const base = await defaults.get(obs, def.kind);
    filters[key] = clampToSchema(key, def.fromObs({ ...base, ...f.filterSettings }, f.filterEnabled) as never) as never;
  }
  return { filters, unavailable };
}

async function listFilters(obs: ObsCalls, input: string): Promise<ObsFilter[]> {
  const r = (await obs.call('GetSourceFilterList', { sourceName: input })) as { filters: ObsFilter[] };
  return r.filters ?? [];
}

/** Puts the streamhub filters in chain order, at the position of the first one; other filters keep their place. */
async function orderChain(obs: ObsCalls, input: string, list: ObsFilter[]) {
  const ours = MIC_FILTER_ORDER.map((k) => list.find((f) => f.filterName === FILTERS[k].name)).filter(
    (f): f is ObsFilter => f !== undefined,
  );
  if (ours.length === 0) return;
  const start = Math.min(...ours.map((f) => f.filterIndex));
  for (const [i, f] of ours.entries()) {
    await obs.call('SetSourceFilterIndex', { sourceName: input, filterName: f.filterName, filterIndex: start + i });
  }
}

export async function writeFilter<K extends MicFilterKey>(
  obs: ObsCalls,
  input: string,
  key: K,
  before: MicFilters[K],
  after: MicFilters[K],
) {
  const def = FILTERS[key];
  await obs.call('SetSourceFilterSettings', {
    sourceName: input,
    filterName: def.name,
    filterSettings: def.toObs(after),
    overlay: true,
  });
  if (before.enabled !== after.enabled) {
    await obs.call('SetSourceFilterEnabled', { sourceName: input, filterName: def.name, filterEnabled: after.enabled });
  }
}

export async function setFilterEnabled(obs: ObsCalls, input: string, key: MicFilterKey, enabled: boolean) {
  await obs.call('SetSourceFilterEnabled', { sourceName: input, filterName: FILTERS[key].name, filterEnabled: enabled });
}

const MONITOR_TO_OBS: Record<Monitor, string> = {
  off: 'OBS_MONITORING_TYPE_NONE',
  monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
  both: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
};
export const monitorToObs = (m: Monitor) => MONITOR_TO_OBS[m];
export function monitorFromObs(t: string): Monitor {
  if (t === MONITOR_TO_OBS.monitor) return 'monitor';
  if (t === MONITOR_TO_OBS.both) return 'both';
  return 'off';
}

export type InputAudio = { volumeDb: number; muted: boolean; monitor: Monitor; syncOffsetMs: number; live: boolean };

export async function readInputAudio(obs: ObsCalls, input: string): Promise<InputAudio> {
  const vol = (await obs.call('GetInputVolume', { inputName: input })) as { inputVolumeDb: number };
  const mute = (await obs.call('GetInputMute', { inputName: input })) as { inputMuted: boolean };
  const mon = (await obs.call('GetInputAudioMonitorType', { inputName: input })) as { monitorType: string };
  const sync = (await obs.call('GetInputAudioSyncOffset', { inputName: input })) as { inputAudioSyncOffset: number };
  const active = (await obs.call('GetSourceActive', { sourceName: input })) as { videoActive: boolean };
  return {
    volumeDb: dbFromObs(vol.inputVolumeDb),
    muted: mute.inputMuted,
    monitor: monitorFromObs(mon.monitorType),
    syncOffsetMs: sync.inputAudioSyncOffset,
    live: active.videoActive,
  };
}

/** OBS reports -inf for a fader at the bottom. */
export const dbFromObs = (db: number) => (Number.isFinite(db) ? Math.max(-100, db) : -100);

/** The mix track while wired to the stream; the isolated track if the mic has one; everything else off. */
export function tracksFor(track: number | null, stream = true): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let t = 1; t <= 6; t++) out[String(t)] = (t === MIX_TRACK && stream) || t === track;
  return out;
}

const BALANCE: Record<MicChannel, number> = { both: 0.5, left: 0, right: 1 };

export async function applyRouting(obs: ObsCalls, input: string, track: number | null, channel: MicChannel, stream = true) {
  await obs.call('SetInputAudioTracks', { inputName: input, inputAudioTracks: tracksFor(track, stream) });
  await obs.call('SetInputAudioBalance', { inputName: input, inputAudioBalance: BALANCE[channel] });
}

/** Mics get isolated tracks in config order; the rest share only the mix. */
export function assignTracks(count: number): Array<number | null> {
  return Array.from({ length: count }, (_, i) => ISOLATED_TRACKS[i] ?? null);
}

export const trackMask = (tracks: number[]) => tracks.reduce((m, t) => m | (1 << (t - 1)), 0);

export type RecordingSetup = { tracks: number[]; detail?: string };

/**
 * Makes OBS record the mix plus every isolated track, and names the tracks after the mics.
 * OBS reads these profile settings when a recording starts, so this must run before StartRecord.
 */
export async function configureRecording(obs: ObsCalls, names: Map<number, string>): Promise<RecordingSetup> {
  const tracks = [MIX_TRACK, ...[...names.keys()].sort((a, b) => a - b)];
  const get = async (category: string, name: string) => {
    const r = (await obs.call('GetProfileParameter', { parameterCategory: category, parameterName: name })) as {
      parameterValue: string | null;
      defaultParameterValue: string | null;
    };
    return r.parameterValue ?? r.defaultParameterValue ?? '';
  };
  const set = (category: string, name: string, value: string) =>
    obs.call('SetProfileParameter', { parameterCategory: category, parameterName: name, parameterValue: value });

  const mode = await get('Output', 'Mode');
  const advanced = mode === 'Advanced';
  const section = advanced ? 'AdvOut' : 'SimpleOutput';
  await set(section, 'RecTracks', String(trackMask(tracks)));
  await set('AdvOut', `Track${MIX_TRACK}Name`, 'Stream mix');
  for (const [t, name] of names) await set('AdvOut', `Track${t}Name`, name);

  const format = await get(section, 'RecFormat2');
  if (format === 'flv') return { tracks, detail: 'FLV recordings hold one audio track: pick MKV or MOV in OBS Settings → Output → Recording.' };
  if (advanced) {
    if ((await get('AdvOut', 'RecType')) === 'FFmpeg') {
      return { tracks, detail: 'OBS records with Custom Output (FFmpeg), which ignores the track picks: set Type to Standard in Settings → Output → Recording.' };
    }
  } else if ((await get('SimpleOutput', 'RecQuality')) === 'Stream') {
    return { tracks, detail: 'Recording quality "Same as stream" keeps one audio track: pick another quality in OBS Settings → Output.' };
  }
  return { tracks };
}

export type Level = { peakDb: number; rmsDb: number; inputPeakDb: number };

const toDb = (mul: number) => (mul > 0 ? Math.max(-100, 20 * Math.log10(mul)) : -100);

/** obs-websocket sends, per channel, [magnitude, peak, input peak] as multipliers; the loudest channel wins. */
export function levelFromMeters(channels: unknown): Level | null {
  if (!Array.isArray(channels) || channels.length === 0) return null;
  let mag = 0;
  let peak = 0;
  let inputPeak = 0;
  for (const ch of channels) {
    if (!Array.isArray(ch)) continue;
    mag = Math.max(mag, num(ch[0], 0));
    peak = Math.max(peak, num(ch[1], 0));
    inputPeak = Math.max(inputPeak, num(ch[2], 0));
  }
  return { rmsDb: toDb(mag), peakDb: toDb(peak), inputPeakDb: toDb(inputPeak) };
}
