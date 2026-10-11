import { useEffect, useState, type ReactNode } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { AudioDevices, AudioState, MicChannel, MicFilterKey, MicFilters, MicPatch, MicState, Monitor } from '@streamhub/shared';
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  formatDb,
  meterPercent,
  meterZone,
  micWarning,
  SPLIT_HINT,
  trackLabel,
  type Levels,
} from '../audio';
import { useAudioLevels } from '../useAudio';
import { ThrottledRange } from './ThrottledRange';

export type MicAddRequest = {
  name: string;
  channel: MicChannel;
  from: { kind: 'device'; device: string } | { kind: 'input'; input: string };
};

export type AudioActions = {
  onSet: (patch: MicPatch) => void;
  onSoundcheck: (id: string, action: 'start' | 'cancel') => void;
  onTarget: (targetDb: number) => void;
  onAdd: (add: MicAddRequest) => void;
  onRemove: (id: string) => void;
  onNest: () => void;
  onListDevices: () => void;
};

/** Subscribes to meter levels in its own component so the rest of the dashboard does not re-render with them. */
export function WithLevels({ client, children }: { client: HubClient; children: (levels: Levels) => ReactNode }) {
  return <>{children(useAudioLevels(client))}</>;
}

export function Meter({ id, levels }: { id: string; levels: Levels }) {
  const l = levels[id];
  const rms = l?.rmsDb ?? -100;
  const peak = l?.peakDb ?? -100;
  return (
    <div className="meter" role="meter" aria-label="Level" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(Math.max(-60, rms))}>
      <div className={`meter-fill ${meterZone(peak)}`} style={{ width: `${meterPercent(rms)}%` }} />
      <div className="meter-peak" style={{ left: `${meterPercent(peak)}%` }} />
    </div>
  );
}

function Fader({ mic, disabled, onSet }: { mic: MicState; disabled: boolean; onSet: AudioActions['onSet'] }) {
  return (
    <ThrottledRange
      label={`${mic.name} volume`}
      value={mic.volumeDb}
      min={FADER_MIN_DB}
      max={FADER_MAX_DB}
      step={0.5}
      disabled={disabled}
      format={(v) => (v <= FADER_MIN_DB ? '−∞' : formatDb(v))}
      onChange={(v) => onSet({ id: mic.id, volumeDb: v <= FADER_MIN_DB ? -100 : v })}
    />
  );
}

function MuteButton({ mic, disabled, onSet }: { mic: MicState; disabled: boolean; onSet: AudioActions['onSet'] }) {
  return (
    <button
      className={mic.muted ? 'mute on' : 'mute'}
      aria-pressed={mic.muted}
      aria-label={mic.muted ? `Unmute ${mic.name}` : `Mute ${mic.name}`}
      disabled={disabled}
      onClick={() => onSet({ id: mic.id, muted: !mic.muted })}
    >
      {mic.muted ? 'Muted' : 'Mute'}
    </button>
  );
}

/** Sidebar mixer: what you need during the show. Tuning lives in Settings → Audio. */
export function Mixer({
  mics,
  levels,
  disabled,
  onSet,
}: {
  mics: MicState[];
  levels: Levels;
  disabled: boolean;
  onSet: AudioActions['onSet'];
}) {
  if (mics.length === 0) return null;
  return (
    <section className="side-section mixer" aria-label="Mics">
      <h2>Mics</h2>
      {mics.map((mic) => {
        const warning = micWarning(mic);
        const off = disabled || mic.status !== 'ok';
        return (
          <div key={mic.id} className="mixer-row" title={warning}>
            <div className="mixer-head">
              <span className={mic.live && mic.status === 'ok' ? 'dot ok' : 'dot'} />
              <span className="scene-name">{mic.name}</span>
              {warning && <span className="cam-warn">!</span>}
              <MuteButton mic={mic} disabled={off} onSet={onSet} />
            </div>
            <Meter id={mic.id} levels={levels} />
            <div className="control">
              <Fader mic={mic} disabled={off} onSet={onSet} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

type Field = { key: string; label: string; min: number; max: number; step: number; unit: string };
const FIELDS: Record<MicFilterKey, { title: string; help: string; fields: Field[] }> = {
  gain: {
    title: 'Gain',
    help: 'Brings the voice to the right level. The sound check sets this for you.',
    fields: [{ key: 'db', label: 'Gain', min: -30, max: 30, step: 0.5, unit: 'dB' }],
  },
  denoise: {
    title: 'Noise suppression',
    help: 'Removes fans, hum and room noise. RNNoise sounds better; Speex uses less CPU.',
    fields: [{ key: 'suppressDb', label: 'Strength (Speex)', min: -60, max: 0, step: 1, unit: 'dB' }],
  },
  gate: {
    title: 'Noise gate',
    help: 'Closes the mic between sentences. Set Open just under the quietest speech.',
    fields: [
      { key: 'openDb', label: 'Open at', min: -96, max: 0, step: 1, unit: 'dB' },
      { key: 'closeDb', label: 'Close at', min: -96, max: 0, step: 1, unit: 'dB' },
      { key: 'attackMs', label: 'Attack', min: 1, max: 500, step: 1, unit: 'ms' },
      { key: 'holdMs', label: 'Hold', min: 1, max: 2000, step: 10, unit: 'ms' },
      { key: 'releaseMs', label: 'Release', min: 1, max: 2000, step: 10, unit: 'ms' },
    ],
  },
  eq: {
    title: 'EQ',
    help: 'Cut Low for boomy mics held close, add a little High for clarity.',
    fields: [
      { key: 'low', label: 'Low', min: -20, max: 20, step: 0.5, unit: 'dB' },
      { key: 'mid', label: 'Mid', min: -20, max: 20, step: 0.5, unit: 'dB' },
      { key: 'high', label: 'High', min: -20, max: 20, step: 0.5, unit: 'dB' },
    ],
  },
  compressor: {
    title: 'Compressor',
    help: 'Evens out loud and quiet moments, so leaning back from the mic matters less.',
    fields: [
      { key: 'ratio', label: 'Ratio', min: 1, max: 32, step: 0.5, unit: ':1' },
      { key: 'thresholdDb', label: 'Threshold', min: -60, max: 0, step: 1, unit: 'dB' },
      { key: 'attackMs', label: 'Attack', min: 1, max: 500, step: 1, unit: 'ms' },
      { key: 'releaseMs', label: 'Release', min: 1, max: 1000, step: 1, unit: 'ms' },
      { key: 'outputDb', label: 'Output gain', min: -32, max: 32, step: 0.5, unit: 'dB' },
    ],
  },
  limiter: {
    title: 'Limiter',
    help: 'A safety ceiling so a shout or laugh never clips the stream.',
    fields: [
      { key: 'thresholdDb', label: 'Ceiling', min: -60, max: 0, step: 0.5, unit: 'dB' },
      { key: 'releaseMs', label: 'Release', min: 1, max: 1000, step: 1, unit: 'ms' },
    ],
  },
};
const FILTER_KEYS = Object.keys(FIELDS) as MicFilterKey[];

function FilterGroup({
  mic,
  k,
  disabled,
  onSet,
}: {
  mic: MicState;
  k: MicFilterKey;
  disabled: boolean;
  onSet: AudioActions['onSet'];
}) {
  const meta = FIELDS[k];
  const value = mic.filters[k] as MicFilters[MicFilterKey] & Record<string, unknown>;
  const patch = (change: Record<string, unknown>) => onSet({ id: mic.id, filters: { [k]: change } });
  const toggleId = `${mic.id}-${k}-on`;
  const listening = mic.soundcheck?.state === 'listening';
  return (
    <fieldset className="camera-controls">
      <legend>{meta.title}</legend>
      <div className="control">
        <label htmlFor={toggleId}>On</label>
        <input
          id={toggleId}
          type="checkbox"
          role="switch"
          checked={value.enabled}
          disabled={disabled || (listening && (k === 'gate' || k === 'compressor' || k === 'limiter'))}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span className="small muted control-help">{meta.help}</span>
      </div>
      {k === 'denoise' && (
        <div className="control">
          <label htmlFor={`${mic.id}-denoise-method`}>Method</label>
          <select
            id={`${mic.id}-denoise-method`}
            value={mic.filters.denoise.method}
            disabled={disabled}
            onChange={(e) => patch({ method: e.target.value })}
          >
            <option value="rnnoise">RNNoise</option>
            <option value="speex">Speex</option>
          </select>
        </div>
      )}
      {meta.fields.map((f) => {
        if (k === 'denoise' && mic.filters.denoise.method !== 'speex') return null;
        const id = `${mic.id}-${k}-${f.key}`;
        return (
          <div className="control" key={f.key}>
            <label htmlFor={id}>{f.label}</label>
            <ThrottledRange
              id={id}
              value={Number(value[f.key])}
              min={f.min}
              max={f.max}
              step={f.step}
              disabled={disabled || !value.enabled}
              format={(v) => `${v}${f.unit === ':1' ? ':1' : ` ${f.unit}`}`}
              onChange={(v) => patch({ [f.key]: v })}
            />
          </div>
        );
      })}
    </fieldset>
  );
}

function SoundcheckView({ mic, disabled, onSoundcheck }: { mic: MicState; disabled: boolean; onSoundcheck: AudioActions['onSoundcheck'] }) {
  const sc = mic.soundcheck;
  const listening = sc?.state === 'listening';
  return (
    <div className="soundcheck">
      <button
        className={listening ? undefined : 'primary'}
        disabled={disabled || (!listening && mic.status !== 'ok')}
        onClick={() => onSoundcheck(mic.id, listening ? 'cancel' : 'start')}
      >
        {listening ? 'Cancel sound check' : 'Sound check'}
      </button>
      {!sc && <span className="small muted">The person talks normally for 10 seconds; the hub sets the gain.</span>}
      {listening && <span className="small">Listening… ask {mic.name} to talk normally until the check ends.</span>}
      {sc?.state === 'done' && (
        <span className="small">
          Speech measured {sc.measuredDb} dBFS; gain set to {formatDb(sc.gainDb ?? 0)}.
          {sc.detail && <span className="conn-error"> {sc.detail}</span>}
        </span>
      )}
      {sc?.state === 'failed' && <span className="small conn-error">{sc.detail}</span>}
    </div>
  );
}

const MONITOR_LABEL: Record<Monitor, string> = { off: 'Off', monitor: 'Headphones only', both: 'Headphones and stream' };

function MicCard({ mic, levels, disabled, actions }: { mic: MicState; levels: Levels; disabled: boolean; actions: AudioActions }) {
  const [name, setName] = useState(mic.name);
  useEffect(() => setName(mic.name), [mic.name]);
  const off = disabled || mic.status !== 'ok';
  const warning = micWarning(mic);
  const rename = () => {
    const n = name.trim();
    if (n && n !== mic.name) actions.onSet({ id: mic.id, name: n });
    else setName(mic.name);
  };
  return (
    <article className="camera-card mic-card" aria-label={mic.name}>
      <div className="camera-head">
        <input
          className="mic-name"
          aria-label="Mic name"
          value={name}
          maxLength={60}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && rename()}
        />
        <span className="small muted">{trackLabel(mic)}</span>
        <span className="spacer" />
        <button className="link" disabled={disabled} onClick={() => actions.onRemove(mic.id)}>
          Remove
        </button>
      </div>
      <p className="small muted">
        OBS input <strong>{mic.input}</strong>
        {mic.channel !== 'both' && ` · ${mic.channel} side`}
      </p>
      {warning && <p className="conn-error small">{warning}</p>}
      {mic.channel !== 'both' && <p className="small muted">{SPLIT_HINT}</p>}
      <Meter id={mic.id} levels={levels} />
      <div className="control">
        <label htmlFor={`${mic.id}-fader`}>Volume</label>
        <ThrottledRange
          id={`${mic.id}-fader`}
          value={mic.volumeDb}
          min={FADER_MIN_DB}
          max={FADER_MAX_DB}
          step={0.5}
          disabled={off}
          format={(v) => (v <= FADER_MIN_DB ? '−∞' : formatDb(v))}
          onChange={(v) => actions.onSet({ id: mic.id, volumeDb: v <= FADER_MIN_DB ? -100 : v })}
        />
        <MuteButton mic={mic} disabled={off} onSet={actions.onSet} />
      </div>
      <div className="control">
        <label htmlFor={`${mic.id}-monitor`}>Monitoring</label>
        <select
          id={`${mic.id}-monitor`}
          value={mic.monitor}
          disabled={off}
          onChange={(e) => actions.onSet({ id: mic.id, monitor: e.target.value as Monitor })}
        >
          {(Object.keys(MONITOR_LABEL) as Monitor[]).map((m) => (
            <option key={m} value={m}>
              {MONITOR_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="control">
        <label htmlFor={`${mic.id}-sync`}>Sync offset</label>
        <ThrottledRange
          id={`${mic.id}-sync`}
          value={mic.syncOffsetMs}
          min={-950}
          max={2000}
          step={10}
          disabled={off}
          format={(v) => `${v} ms`}
          onChange={(v) => actions.onSet({ id: mic.id, syncOffsetMs: v })}
        />
        <span className="small muted control-help">Delays this mic to match a camera that lags.</span>
      </div>
      <SoundcheckView mic={mic} disabled={disabled} onSoundcheck={actions.onSoundcheck} />
      <details className="mic-filters">
        <summary>Voice filters</summary>
        {FILTER_KEYS.map((k) => (
          <FilterGroup key={k} mic={mic} k={k} disabled={off} onSet={actions.onSet} />
        ))}
      </details>
    </article>
  );
}

function AddMic({ devices, disabled, actions }: { devices: AudioDevices | null; disabled: boolean; actions: AudioActions }) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [channel, setChannel] = useState<MicChannel>('both');
  const add = () => {
    const [kind, ...rest] = source.split(':');
    const value = rest.join(':');
    if (!name.trim() || !value) return;
    actions.onAdd({
      name: name.trim(),
      channel,
      from: kind === 'input' ? { kind: 'input', input: value } : { kind: 'device', device: value },
    });
    setName('');
    setSource('');
    setChannel('both');
  };
  return (
    <section className="group">
      <div className="group-row form">
        <strong>Add a mic</strong>
        <label className="field">
          <span className="field-label">Name (who uses it)</span>
          <input value={name} maxLength={60} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Source</span>
          <select value={source} disabled={disabled} onChange={(e) => setSource(e.target.value)}>
            <option value="">Choose…</option>
            {devices && devices.devices.length > 0 && (
              <optgroup label="Audio devices (creates an OBS input)">
                {devices.devices.map((d) => (
                  <option key={d.id} value={`device:${d.id}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            )}
            {devices && devices.inputs.length > 0 && (
              <optgroup label="Existing OBS inputs">
                {devices.inputs.map((n) => (
                  <option key={n} value={`input:${n}`}>
                    {n}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Side</span>
          <select value={channel} disabled={disabled} onChange={(e) => setChannel(e.target.value as MicChannel)}>
            <option value="both">Whole device</option>
            <option value="left">Left side (input 1 / transmitter 1)</option>
            <option value="right">Right side (input 2 / transmitter 2)</option>
          </select>
        </label>
        <div className="control">
          <button className="primary" disabled={disabled || !name.trim() || !source} onClick={add}>
            Add mic
          </button>
          <button disabled={disabled} onClick={actions.onListDevices}>
            Refresh devices
          </button>
          <button disabled={disabled} onClick={actions.onNest} title="Puts the streamhub mics scene into every scene">
            Add mics to all scenes
          </button>
        </div>
        {devices?.detail && <p className="small">{devices.detail}</p>}
      </div>
    </section>
  );
}

function recordingSummary(state: AudioState): string {
  const names = new Map(state.mics.filter((m) => m.track !== null).map((m) => [m.track, m.name]));
  return state.recordTracks.map((t) => (t === 1 ? 'Stream mix (track 1)' : `${names.get(t) ?? '?'} (track ${t})`)).join(', ');
}

export function AudioPanel({
  state,
  devices,
  levels,
  disabled,
  actions,
}: {
  state: AudioState | null;
  devices: AudioDevices | null;
  levels: Levels;
  disabled: boolean;
  actions: AudioActions;
}) {
  const { onListDevices } = actions;
  useEffect(() => {
    if (!disabled) onListDevices();
    // Only when the tab opens or the hub comes back, not on every render.
  }, [disabled]);
  if (!state) return <p className="muted">Waiting for the hub…</p>;
  return (
    <section className="cameras audio">
      <section className="group">
        <div className="group-row form">
          <div className="control">
            <label htmlFor="audio-target">Sound check target</label>
            <ThrottledRange
              id="audio-target"
              value={state.targetDb}
              min={-40}
              max={-6}
              step={1}
              disabled={disabled}
              format={(v) => `${v} dBFS`}
              onChange={actions.onTarget}
            />
            <span className="small muted control-help">Speech level every mic is set to. −20 suits most shows.</span>
          </div>
          <p className="small">
            OBS records: {recordingSummary(state)}
            {state.tracksPending && <span className="muted"> · track changes apply to the next recording</span>}
          </p>
          {state.recordDetail && <p className="small conn-error">{state.recordDetail}</p>}
        </div>
      </section>
      {state.mics.length === 0 && <p className="muted">No mics yet. Add one below.</p>}
      <div className="camera-grid">
        {state.mics.map((mic) => (
          <MicCard key={mic.id} mic={mic} levels={levels} disabled={disabled} actions={actions} />
        ))}
      </div>
      <AddMic devices={devices} disabled={disabled} actions={actions} />
    </section>
  );
}
