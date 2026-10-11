import { useEffect, useId, useState } from 'react';
import {
  AUDIO_MONITOR_URL,
  HEADSET_MAX_DB,
  HEADSET_MIN_DB,
  type HeadsetAdd,
  type HeadsetPatch,
  type HeadsetSendPatch,
  type HeadsetSource,
  type HeadsetsState,
  type HeadsetState,
  type MicState,
} from '@streamhub/shared';
import { formatDb } from '../audio';
import { ThrottledRange } from './ThrottledRange';

export type HeadsetActions = {
  onAdd: (add: HeadsetAdd) => void;
  onUpdate: (patch: HeadsetPatch) => void;
  onRemove: (id: string) => void;
  onSetSend: (patch: HeadsetSendPatch) => void;
  onListOutputs: () => void;
};

const DEFAULT_SEND = { on: true, db: 0 };

/** A device name: pick one the computer listed, or type it when the list is empty or wrong. */
function DeviceInput({
  value,
  outputs,
  label,
  disabled,
  onChange,
  onCommit,
}: {
  value: string;
  outputs: string[];
  label: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onCommit?: () => void;
}) {
  const list = useId();
  return (
    <>
      <input
        aria-label={label}
        list={list}
        value={value}
        maxLength={300}
        disabled={disabled}
        placeholder="Output device"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === 'Enter' && onCommit?.()}
      />
      <datalist id={list}>
        {outputs.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

function HeadsetHead({
  h,
  mics,
  outputs,
  disabled,
  actions,
}: {
  h: HeadsetState;
  mics: MicState[];
  outputs: string[];
  disabled: boolean;
  actions: HeadsetActions;
}) {
  const [device, setDevice] = useState(h.device);
  useEffect(() => setDevice(h.device), [h.device]);
  const commitDevice = () => {
    const d = device.trim();
    if (d && d !== h.device) actions.onUpdate({ id: h.id, device: d });
    else setDevice(h.device);
  };
  return (
    <th scope="col" className="hp-head" aria-label={h.name}>
      <div className="hp-title">
        <strong>{h.name}</strong>
        <span className="spacer" />
        <button className="link" disabled={disabled} onClick={() => actions.onRemove(h.id)} aria-label={`Remove ${h.name}`}>
          Remove
        </button>
      </div>
      <select
        aria-label={`Who wears ${h.name}`}
        value={h.owner ?? ''}
        disabled={disabled}
        onChange={(e) => actions.onUpdate({ id: h.id, owner: e.target.value || null })}
      >
        <option value="">No one</option>
        {mics.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <DeviceInput
        label={`${h.name} output`}
        value={device}
        outputs={outputs}
        disabled={disabled}
        onChange={setDevice}
        onCommit={commitDevice}
      />
      <div className="control">
        <ThrottledRange
          label={`${h.name} master level`}
          value={h.masterDb}
          min={HEADSET_MIN_DB}
          max={HEADSET_MAX_DB}
          step={0.5}
          disabled={disabled}
          format={formatDb}
          onChange={(v) => actions.onUpdate({ id: h.id, masterDb: v })}
        />
        <button
          className={h.muted ? 'mute on' : 'mute'}
          aria-pressed={h.muted}
          aria-label={h.muted ? `Unmute ${h.name}` : `Mute ${h.name}`}
          disabled={disabled}
          onClick={() => actions.onUpdate({ id: h.id, muted: !h.muted })}
        >
          {h.muted ? 'Muted' : 'Mute'}
        </button>
      </div>
      {h.detail && <p className={h.status === 'ok' ? 'small muted' : 'small conn-error'}>{h.detail}</p>}
    </th>
  );
}

function SendCell({
  h,
  source,
  disabled,
  onSetSend,
}: {
  h: HeadsetState;
  source: HeadsetSource;
  disabled: boolean;
  onSetSend: HeadsetActions['onSetSend'];
}) {
  const send = h.sends[source.key] ?? DEFAULT_SEND;
  const self = h.owner !== null && source.key === `mic:${h.owner}`;
  return (
    <td className={send.on ? 'hp-cell' : 'hp-cell off'}>
      <div className="control">
        <button
          className="switch"
          role="switch"
          aria-checked={send.on}
          aria-label={`${source.name} in ${h.name}`}
          disabled={disabled}
          onClick={() => onSetSend({ id: h.id, source: source.key, on: !send.on })}
        />
        <ThrottledRange
          label={`${source.name} level in ${h.name}`}
          value={send.db}
          min={HEADSET_MIN_DB}
          max={HEADSET_MAX_DB}
          step={0.5}
          disabled={disabled || !send.on}
          format={formatDb}
          onChange={(v) => onSetSend({ id: h.id, source: source.key, db: v })}
        />
        {self && (
          <span className="badge" title={`${h.name} hears their own voice`}>
            self
          </span>
        )}
      </div>
    </td>
  );
}

function AddHeadset({
  mics,
  outputs,
  outputsDetail,
  disabled,
  actions,
}: {
  mics: MicState[];
  outputs: string[];
  outputsDetail?: string;
  disabled: boolean;
  actions: HeadsetActions;
}) {
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [owner, setOwner] = useState('');
  const ready = name.trim() !== '' && device.trim() !== '';
  const add = () => {
    if (!ready) return;
    actions.onAdd({ name: name.trim(), device: device.trim(), owner: owner || null });
    setName('');
    setDevice('');
    setOwner('');
  };
  return (
    <div className="group-row form">
      <strong>Add a headset</strong>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} maxLength={60} disabled={disabled} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Worn by</span>
        <select value={owner} disabled={disabled} onChange={(e) => setOwner(e.target.value)}>
          <option value="">No one</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="field-label">Output</span>
        <DeviceInput label="Output" value={device} outputs={outputs} disabled={disabled} onChange={setDevice} />
      </div>
      <div className="control">
        <button className="primary" disabled={disabled || !ready} onClick={add}>
          Add headset
        </button>
        <button disabled={disabled} onClick={actions.onListOutputs}>
          Refresh outputs
        </button>
      </div>
      {outputsDetail && <p className="small muted">{outputsDetail}</p>}
    </div>
  );
}

/** One row per source, one column per headset: who hears what, and how loud. */
export function HeadsetMatrix({
  state,
  mics,
  disabled,
  actions,
}: {
  state: HeadsetsState | null;
  mics: MicState[];
  disabled: boolean;
  actions: HeadsetActions;
}) {
  const { onListOutputs } = actions;
  useEffect(() => {
    if (!disabled) onListOutputs();
    // Only when the tab opens or the hub comes back, not on every render.
  }, [disabled]);
  if (!state) return <p className="muted">Waiting for the hub…</p>;
  // The hub can only switch sends while the plugin is there; config changes are still saved.
  const noPlugin = state.plugin === false;
  return (
    <section className="group headsets" aria-label="Headsets">
      <div className="group-row form">
        <p className="small muted">
          Each person gets their own mix in their own headset. Levels go up to 0 dB; to make a headset louder overall,
          raise its master level or the headphone volume.
        </p>
        {noPlugin && (
          <p className="small conn-error" role="alert">
            Headset mixes need the Audio Monitor plugin in OBS.{' '}
            <a href={AUDIO_MONITOR_URL} target="_blank" rel="noreferrer">
              Install Audio Monitor
            </a>
            , then restart OBS.
          </p>
        )}
      </div>
      {state.headsets.length > 0 && (
        <div className="group-row hp-scroll">
          <table className="hp-matrix">
            <thead>
              <tr>
                <th scope="col" className="hp-source">
                  Source
                </th>
                {state.headsets.map((h) => (
                  <HeadsetHead key={h.id} h={h} mics={mics} outputs={state.outputs} disabled={disabled} actions={actions} />
                ))}
              </tr>
            </thead>
            <tbody>
              {state.sources.map((source) => (
                <tr key={source.key}>
                  <th scope="row" className="hp-source">
                    {source.name}
                    {source.kind === 'obs' && <span className="small muted"> · OBS</span>}
                  </th>
                  {state.headsets.map((h) => (
                    <SendCell key={h.id} h={h} source={source} disabled={disabled} onSetSend={actions.onSetSend} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {state.sources.length === 0 && <p className="small muted">No mics or OBS audio yet.</p>}
        </div>
      )}
      <AddHeadset
        mics={mics}
        outputs={state.outputs}
        outputsDetail={state.outputsDetail}
        disabled={disabled}
        actions={actions}
      />
    </section>
  );
}
