import { EventEmitter } from 'node:events';

/** A small, stateful stand-in for OBS's audio side, speaking obs-websocket request names. */
export type FakeInput = {
  kind: string;
  settings: Record<string, unknown>;
  volumeDb: number;
  muted: boolean;
  monitorType: string;
  syncOffset: number;
  balance: number;
  tracks: Record<string, boolean>;
  active: boolean;
  filters: Array<{ name: string; kind: string; enabled: boolean; settings: Record<string, unknown> }>;
};

export class ObsRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const NOT_FOUND = 600;
const UNKNOWN_REQUEST = 204;

export const FILTER_DEFAULTS: Record<string, Record<string, unknown>> = {
  gain_filter: { db: 0 },
  noise_suppress_filter_v2: { method: 'rnnoise', suppress_level: -30, intensity: 1 },
  noise_gate_filter: { open_threshold: -26, close_threshold: -32, attack_time: 25, hold_time: 200, release_time: 150 },
  basic_eq_filter: { low: 0, mid: 0, high: 0 },
  compressor_filter: { ratio: 10, threshold: -18, attack_time: 6, release_time: 60, output_gain: 0, sidechain_source: 'none' },
  limiter_filter: { threshold: -6, release_time: 60 },
  audio_monitor: { volume: 100, device: 'default' },
};

export function makeInput(over: Partial<FakeInput> = {}): FakeInput {
  return {
    kind: 'coreaudio_input_capture',
    settings: {},
    volumeDb: 0,
    muted: false,
    monitorType: 'OBS_MONITORING_TYPE_NONE',
    syncOffset: 0,
    balance: 0.5,
    tracks: { '1': true, '2': true, '3': true, '4': true, '5': true, '6': true },
    active: true,
    filters: [],
    ...over,
  };
}

export class FakeObsAudio extends EventEmitter {
  inputs = new Map<string, FakeInput>();
  scenes = new Map<string, string[]>([['Main', []]]);
  profile = new Map<string, string>([
    ['Output/Mode', 'Simple'],
    ['SimpleOutput/RecTracks', '1'],
    ['SimpleOutput/RecFormat2', 'hybrid_mov'],
    ['SimpleOutput/RecQuality', 'Small'],
  ]);
  inputKinds = ['coreaudio_input_capture', 'coreaudio_output_capture', 'ffmpeg_source'];
  devices = [
    { itemName: 'Default', itemEnabled: true, itemValue: 'default' },
    { itemName: 'Rode NT-USB', itemEnabled: true, itemValue: 'AppleUSBAudioEngine:RODE:NT-USB' },
    { itemName: 'Unplugged mic', itemEnabled: false, itemValue: 'gone' },
  ];
  /** Filter kinds OBS has; drop one to act as if its plugin is not installed. */
  filterKinds = Object.keys(FILTER_DEFAULTS);
  recording = false;
  /** Request types to fail with an error, for testing failure paths. */
  failing = new Set<string>();
  calls: Array<[string, Record<string, unknown>]> = [];

  callsOf(type: string) {
    return this.calls.filter(([t]) => t === type).map(([, d]) => d);
  }

  private input(name: unknown): FakeInput {
    const i = this.inputs.get(String(name));
    if (!i) throw new ObsRequestError(NOT_FOUND, `No source was found by the name of \`${String(name)}\`.`);
    return i;
  }

  private filter(source: unknown, name: unknown) {
    const f = this.input(source).filters.find((x) => x.name === name);
    if (!f) throw new ObsRequestError(NOT_FOUND, `No filter was found by the name of \`${String(name)}\`.`);
    return f;
  }

  async call(type: string, data: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([type, data]);
    if (this.failing.has(type)) throw new Error(`${type} failed`);
    switch (type) {
      case 'GetInputList':
        return {
          inputs: [...this.inputs].map(([inputName, i]) => ({ inputName, inputKind: i.kind, unversionedInputKind: i.kind })),
        };
      case 'GetInputKindList':
        return { inputKinds: this.inputKinds };
      case 'GetSceneList':
        return { scenes: [...this.scenes.keys()].map((sceneName, i) => ({ sceneName, sceneIndex: i })) };
      case 'CreateScene':
        this.scenes.set(String(data.sceneName), []);
        return {};
      case 'CreateInput': {
        const name = String(data.inputName);
        if (this.inputs.has(name)) throw new ObsRequestError(601, 'already exists');
        this.inputs.set(
          name,
          makeInput({ kind: String(data.inputKind), settings: (data.inputSettings as Record<string, unknown>) ?? {} }),
        );
        this.scenes.get(String(data.sceneName))?.push(name);
        this.emit('InputCreated', { inputName: name });
        return { sceneItemId: 1 };
      }
      case 'RemoveInput':
        this.input(data.inputName);
        this.inputs.delete(String(data.inputName));
        for (const items of this.scenes.values()) {
          const i = items.indexOf(String(data.inputName));
          if (i >= 0) items.splice(i, 1);
        }
        this.emit('InputRemoved', { inputName: data.inputName });
        return {};
      case 'GetSceneItemList': {
        const items = this.scenes.get(String(data.sceneName));
        if (!items) throw new ObsRequestError(NOT_FOUND, 'no scene');
        return { sceneItems: items.map((sourceName, i) => ({ sourceName, sceneItemId: i + 1, sceneItemIndex: i })) };
      }
      case 'CreateSceneItem':
        this.scenes.get(String(data.sceneName))?.push(String(data.sourceName));
        return { sceneItemId: 99 };
      case 'GetInputPropertiesListPropertyItems':
        this.input(data.inputName);
        return { propertyItems: this.devices };
      case 'GetSourceFilterList':
        return {
          filters: this.input(data.sourceName).filters.map((f, filterIndex) => ({
            filterName: f.name,
            filterKind: f.kind,
            filterIndex,
            filterEnabled: f.enabled,
            filterSettings: f.settings,
          })),
        };
      case 'GetSourceFilterDefaultSettings': {
        const d = FILTER_DEFAULTS[String(data.filterKind)];
        if (!d) throw new ObsRequestError(NOT_FOUND, 'unknown filter kind');
        return { defaultFilterSettings: d };
      }
      case 'GetSourceFilterKindList':
        return { sourceFilterKinds: this.filterKinds };
      case 'CreateSourceFilter': {
        const kind = String(data.filterKind);
        if (!FILTER_DEFAULTS[kind] || !this.filterKinds.includes(kind)) throw new ObsRequestError(NOT_FOUND, 'unknown filter kind');
        const i = this.input(data.sourceName);
        i.filters.push({ name: String(data.filterName), kind, enabled: true, settings: { ...(data.filterSettings as object) } });
        this.emit('SourceFilterCreated', { sourceName: data.sourceName, filterName: data.filterName });
        return {};
      }
      case 'RemoveSourceFilter': {
        const list = this.input(data.sourceName).filters;
        list.splice(list.indexOf(this.filter(data.sourceName, data.filterName)), 1);
        this.emit('SourceFilterRemoved', { sourceName: data.sourceName, filterName: data.filterName });
        return {};
      }
      case 'SetSourceFilterEnabled':
        this.filter(data.sourceName, data.filterName).enabled = Boolean(data.filterEnabled);
        this.emit('SourceFilterEnableStateChanged', data);
        return {};
      case 'SetSourceFilterIndex': {
        const list = this.input(data.sourceName).filters;
        const f = this.filter(data.sourceName, data.filterName);
        list.splice(list.indexOf(f), 1);
        list.splice(Number(data.filterIndex), 0, f);
        return {};
      }
      case 'SetSourceFilterSettings': {
        const f = this.filter(data.sourceName, data.filterName);
        f.settings = data.overlay === false ? { ...(data.filterSettings as object) } : { ...f.settings, ...(data.filterSettings as object) };
        this.emit('SourceFilterSettingsChanged', { sourceName: data.sourceName, filterName: data.filterName, filterSettings: f.settings });
        return {};
      }
      case 'GetInputVolume': {
        const i = this.input(data.inputName);
        return { inputVolumeDb: i.volumeDb, inputVolumeMul: 10 ** (i.volumeDb / 20) };
      }
      case 'SetInputVolume': {
        const i = this.input(data.inputName);
        i.volumeDb = Number(data.inputVolumeDb);
        this.emit('InputVolumeChanged', { inputName: data.inputName, inputVolumeDb: i.volumeDb });
        return {};
      }
      case 'GetInputMute':
        return { inputMuted: this.input(data.inputName).muted };
      case 'SetInputMute':
        this.input(data.inputName).muted = Boolean(data.inputMuted);
        this.emit('InputMuteStateChanged', { inputName: data.inputName, inputMuted: data.inputMuted });
        return {};
      case 'GetInputAudioMonitorType':
        return { monitorType: this.input(data.inputName).monitorType };
      case 'SetInputAudioMonitorType':
        this.input(data.inputName).monitorType = String(data.monitorType);
        return {};
      case 'GetInputAudioSyncOffset':
        return { inputAudioSyncOffset: this.input(data.inputName).syncOffset };
      case 'SetInputAudioSyncOffset':
        this.input(data.inputName).syncOffset = Number(data.inputAudioSyncOffset);
        return {};
      case 'SetInputAudioBalance':
        this.input(data.inputName).balance = Number(data.inputAudioBalance);
        return {};
      case 'SetInputAudioTracks':
        this.input(data.inputName).tracks = { ...(data.inputAudioTracks as Record<string, boolean>) };
        return {};
      case 'GetInputAudioTracks':
        return { inputAudioTracks: { ...this.input(data.inputName).tracks } };
      case 'GetSourceActive':
        return { videoActive: this.input(data.sourceName).active, videoShowing: this.input(data.sourceName).active };
      case 'GetProfileParameter': {
        const v = this.profile.get(`${String(data.parameterCategory)}/${String(data.parameterName)}`);
        return { parameterValue: v ?? null, defaultParameterValue: null };
      }
      case 'SetProfileParameter':
        this.profile.set(`${String(data.parameterCategory)}/${String(data.parameterName)}`, String(data.parameterValue));
        return {};
      case 'GetRecordStatus':
        return { outputActive: this.recording, outputDuration: 0 };
      default:
        throw new ObsRequestError(UNKNOWN_REQUEST, `unknown request ${type}`);
    }
  }

  onObs<T>(event: string, listener: (data: T) => void) {
    this.on(event, listener as (d: unknown) => void);
  }

  /** One meter frame: per channel [magnitude, peak, input peak] as multipliers. */
  meters(levels: Record<string, Array<[number, number, number]>>) {
    this.emit('InputVolumeMeters', {
      inputs: Object.entries(levels).map(([inputName, inputLevelsMul]) => ({ inputName, inputLevelsMul })),
    });
  }
}

export const dbToMul = (db: number) => 10 ** (db / 20);
