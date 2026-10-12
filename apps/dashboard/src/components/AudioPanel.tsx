import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { AudioDevices, AudioState, MicChannel, MicFilterKey, MicFilters, MicPatch, MicState, Monitor } from '@streamhub/shared';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb, meterPercent, meterZone, micWarning, SPLIT_HINT, trackLabel } from '../audio';
import type { Level, LevelsStore } from '../levels';
import { Icon } from './Icon';
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

export function Meter({ level }: { level?: Level }) {
  const rms = level?.rmsDb ?? -100;
  const peak = level?.peakDb ?? -100;
  return (
    <div className="meter" role="meter" aria-label="Level" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(Math.max(-60, rms))}>
      <div className={`meter-fill ${meterZone(peak)}`} style={{ '--level': meterPercent(rms) / 100 } as CSSProperties} />
      <div className="meter-peak" style={{ '--peak': `${meterPercent(peak)}%` } as CSSProperties} />
    </div>
  );
}

/** The only component that re-renders on level ticks: it subscribes to one mic in the levels store. */
export function LiveMeter({ store, id }: { store: LevelsStore; id: string }) {
  const subscribe = useCallback((notify: () => void) => store.subscribe(id, notify), [store, id]);
  return <Meter level={useSyncExternalStore(subscribe, () => store.get(id))} />;
}

export function Fader({ mic, disabled, onSet }: { mic: MicState; disabled: boolean; onSet: AudioActions['onSet'] }) {
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

export function MuteButton({ mic, disabled, onSet }: { mic: MicState; disabled: boolean; onSet: AudioActions['onSet'] }) {
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

type Field = { key: string; label: string; min: number; max: number; step: number; unit: string };
const FIELDS: Record<MicFilterKey, { title: string; help: string; fields: Field[] }> = {
  gain: {
    title: 'Gain',
    help: 'Brings the voice to the right level. The sound check sets this for you.',
    fields: [{ key: 'db', label: 'Gain', min: -30, max: 30, step: 0.5, unit: 'dB' }],
  },
  denoise: {
    title: 'Noise removal',
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
    title: 'Voice EQ',
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
/** The clean-up rows in the side panel; gain lives in the Level group instead. */
const CLEANUP_KEYS = FILTER_KEYS.filter((k) => k !== 'gain');

/**
 * One voice filter in the side panel: a plain row with its on/off switch, and its
 * settings behind a Settings button. Gain shows its slider inline because it is
 * the one setting people touch by hand.
 */
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
  const [open, setOpen] = useState(false);
  const value = mic.filters[k] as MicFilters[MicFilterKey] & Record<string, unknown>;
  const patch = (change: Record<string, unknown>) => onSet({ id: mic.id, filters: { [k]: change } });
  const listening = mic.soundcheck?.state === 'listening';
  const id = `${mic.id}-${k}`;
  const params = (
    <>
      <p className="small muted filter-help">{meta.help}</p>
      {k === 'denoise' && (
        <div className="detail-line">
          <label htmlFor={`${id}-method`}>Method</label>
          <select
            id={`${id}-method`}
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
        return (
          <div className="detail-line" key={f.key}>
            <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
            <ThrottledRange
              id={`${id}-${f.key}`}
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
    </>
  );
  return (
    <div className="filter-row" role="group" aria-label={meta.title}>
      <span className="filter-name">{meta.title}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={meta.title}
        checked={value.enabled}
        disabled={disabled || (listening && (k === 'gate' || k === 'compressor' || k === 'limiter'))}
        onChange={(e) => patch({ enabled: e.target.checked })}
      />
      {k === 'gain' ? (
        <div className="filter-params">{params}</div>
      ) : (
        <>
          <button className="link small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Settings
          </button>
          {open && <div className="filter-params">{params}</div>}
        </>
      )}
    </div>
  );
}

export function SoundcheckView({ mic, disabled, onSoundcheck }: { mic: MicState; disabled: boolean; onSoundcheck: AudioActions['onSoundcheck'] }) {
  const sc = mic.soundcheck;
  const listening = sc?.state === 'listening';
  return (
    <div className="soundcheck">
      <button
        className={listening ? undefined : 'primary'}
        disabled={disabled || (!listening && mic.status !== 'ok')}
        onClick={() => onSoundcheck(mic.id, listening ? 'cancel' : 'start')}
      >
        {listening ? 'Cancel sound check' : 'Start sound check'}
      </button>
      {listening && <p className="small">Listening… ask {mic.name} to talk normally until the check ends.</p>}
      {sc?.state === 'done' && (
        <p className="small">
          Speech measured {sc.measuredDb} dBFS; gain set to {formatDb(sc.gainDb ?? 0)}.
          {sc.detail && <span className="conn-error"> {sc.detail}</span>}
        </p>
      )}
      {sc?.state === 'failed' && <p className="small conn-error">{sc.detail}</p>}
    </div>
  );
}

const MONITOR_LABEL: Record<Monitor, string> = { off: 'Off', monitor: 'Headphones only', both: 'Headphones and stream' };

/** Everything about one mic, in the right-hand side panel: sound check, level, clean up, device, remove. */
export function MicCard({
  mic,
  levels,
  disabled,
  actions,
  targetDb = -20,
  onClose,
}: {
  mic: MicState;
  levels: LevelsStore;
  disabled: boolean;
  actions: AudioActions;
  /** Speech level the sound check aims for, dBFS. */
  targetDb?: number;
  onClose?: () => void;
}) {
  const [name, setName] = useState(mic.name);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setName(mic.name), [mic.name]);
  const off = disabled || mic.status !== 'ok';
  const warning = micWarning(mic);
  const rename = () => {
    const n = name.trim();
    if (n && n !== mic.name) actions.onSet({ id: mic.id, name: n });
    else setName(mic.name);
  };
  const side = mic.channel === 'left' ? ', left side' : mic.channel === 'right' ? ', right side' : '';
  return (
    <article className="mic-detail" aria-label={mic.name}>
      <div className="detail-head">
        <div className="detail-title">
          <span className="small muted">Voice settings</span>
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
        </div>
        {onClose && (
          <button className="icon-button" aria-label={`Close ${mic.name}`} onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {warning && <p className="small conn-error">{warning}</p>}
      <div className="detail-check">
        <strong>Sound check</strong>
        <p className="small muted">
          Speak normally for 10 seconds. streamhub sets the gain so the voice lands at {targetDb} dBFS (dBFS is how loud a
          sound is; 0 is the loudest a recording can hold).
        </p>
        <LiveMeter store={levels} id={mic.id} />
        <SoundcheckView mic={mic} disabled={disabled} onSoundcheck={actions.onSoundcheck} />
      </div>
      <section className="detail-group" aria-label="Level">
        <h3>Level</h3>
        <FilterGroup mic={mic} k="gain" disabled={off} onSet={actions.onSet} />
        <div className="detail-line">
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
        </div>
        <p className="small muted detail-help">Delays this mic to match a camera that runs late.</p>
      </section>
      <section className="detail-group" aria-label="Clean up">
        <h3>Clean up</h3>
        {CLEANUP_KEYS.map((k) => (
          <FilterGroup key={k} mic={mic} k={k} disabled={off} onSet={actions.onSet} />
        ))}
      </section>
      <section className="detail-group" aria-label="Device">
        <h3>Device</h3>
        <div className="detail-line">
          <span className="detail-key">Source</span>
          <span className="small muted">
            <strong>{mic.input}</strong>
            {side} · {trackLabel(mic)}
          </span>
        </div>
        {mic.channel !== 'both' && <p className="small muted detail-help">{SPLIT_HINT}</p>}
        <div className="detail-line">
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
        <p className="small muted detail-help">Hear this mic in your headphones.</p>
      </section>
      {confirming ? (
        <div className="detail-confirm" role="alert">
          <p className="small">Remove {mic.name} from the show? The OBS input stays; the mics after it move up one track.</p>
          <div className="detail-confirm-actions">
            <button className="danger" onClick={() => actions.onRemove(mic.id)}>
              Remove
            </button>
            <button onClick={() => setConfirming(false)}>Keep</button>
          </div>
        </div>
      ) : (
        <button className="detail-remove" disabled={disabled} onClick={() => setConfirming(true)}>
          Remove {mic.name}
        </button>
      )}
    </article>
  );
}

/** The Add a mic form, shown in a sheet opened from the dashed card on the Mics page. */
export function AddMic({
  devices,
  disabled,
  actions,
  onAdded,
}: {
  devices: AudioDevices | null;
  disabled: boolean;
  actions: AudioActions;
  /** Closes the sheet after a mic is added. */
  onAdded?: () => void;
}) {
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
    onAdded?.();
  };
  return (
    <div className="add-mic-form">
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
      <p className="small muted">
        Two people on one device? Add it twice, once with Left side and once with Right side; each person gets their own
        track.
      </p>
      <div className="form-actions">
        <button disabled={disabled} onClick={actions.onListDevices}>
          Refresh devices
        </button>
        <button className="primary" disabled={disabled || !name.trim() || !source} onClick={add}>
          Add mic
        </button>
      </div>
      {devices?.detail && <p className="small muted">{devices.detail}</p>}
    </div>
  );
}

export function recordingSummary(state: AudioState): string {
  const names = new Map(state.mics.filter((m) => m.track !== null).map((m) => [m.track, m.name]));
  return state.recordTracks.map((t) => (t === 1 ? 'Stream mix (track 1)' : `${names.get(t) ?? '?'} (track ${t})`)).join(', ');
}
