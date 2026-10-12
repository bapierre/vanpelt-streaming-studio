import { memo, useEffect, useId, useState } from 'react';
import {
  AUDIO_MONITOR_URL,
  HEADSET_MAX_DB,
  HEADSET_MIN_DB,
  type HeadsetAdd,
  type HeadsetPatch,
  type HeadsetSendPatch,
  type HeadsetsState,
  type HeadsetState,
  type MicState,
  type Mirror,
  type RenameSource,
  type SourceKey,
  type StreamSendPatch,
} from '@streamhub/shared';
import { formatDb } from '../audio';
import { ThrottledRange } from './ThrottledRange';

export type HeadsetActions = {
  onAdd: (add: HeadsetAdd) => void;
  onUpdate: (patch: HeadsetPatch) => void;
  onRemove: (id: string) => void;
  onSetSend: (patch: HeadsetSendPatch) => void;
  onSetStream: (patch: StreamSendPatch) => void;
  onRenameSource: (patch: RenameSource) => void;
  onListOutputs: () => void;
};

const DEFAULT_SEND = { on: true, db: 0 };
const STREAM_MIN_DB = -100;
const STREAM_MAX_DB = 26;

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

const HeadsetHead = memo(function HeadsetHead({
  h,
  headsets,
  mics,
  outputs,
  disabled,
  actions,
}: {
  h: HeadsetState;
  headsets: HeadsetState[];
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
  const followName = h.mirror === 'stream' ? null : headsets.find((o) => o.id === h.mirror)?.name;
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
      <select
        aria-label={`${h.name} follows`}
        value={h.mirror ?? ''}
        disabled={disabled}
        onChange={(e) => actions.onUpdate({ id: h.id, mirror: (e.target.value === '' ? null : e.target.value) as Mirror | null })}
      >
        <option value="">Own mix</option>
        <option value="stream">Stream mix</option>
        {headsets
          .filter((o) => o.id !== h.id)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
      </select>
      {h.mirror !== null && (
        <p className="small muted">{h.mirror === 'stream' ? 'Following the stream mix' : `Following ${followName ?? h.mirror}`}</p>
      )}
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
});

/** One send, memoized on primitives: a headsets.state tick re-renders only the cells that changed. */
export const SendCell = memo(function SendCell({
  headsetId,
  headsetName,
  sourceKey,
  sourceName,
  on,
  db,
  self,
  mirrored,
  disabled,
  onSetSend,
}: {
  headsetId: string;
  headsetName: string;
  sourceKey: string;
  sourceName: string;
  on: boolean;
  db: number;
  self: boolean;
  mirrored: boolean;
  disabled: boolean;
  onSetSend: HeadsetActions['onSetSend'];
}) {
  return (
    <td className={`hp-cell${on ? '' : ' off'}${mirrored ? ' mirrored' : ''}`}>
      <div className="control">
        <button
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={`${sourceName} in ${headsetName}`}
          disabled={disabled || mirrored}
          onClick={() => onSetSend({ id: headsetId, source: sourceKey, on: !on })}
        />
        <ThrottledRange
          label={`${sourceName} level in ${headsetName}`}
          value={db}
          min={HEADSET_MIN_DB}
          max={HEADSET_MAX_DB}
          step={0.5}
          disabled={disabled || mirrored || !on}
          format={formatDb}
          onChange={(v) => onSetSend({ id: headsetId, source: sourceKey, db: v })}
        />
        {self && (
          <span className="badge" title={`${headsetName} hears their own voice`}>
            self
          </span>
        )}
      </div>
    </td>
  );
});

/** The stream column cell: what the audience hears of one source. */
const StreamCell = memo(function StreamCell({
  sourceKey,
  sourceName,
  on,
  db,
  disabled,
  onSetStream,
}: {
  sourceKey: SourceKey;
  sourceName: string;
  on: boolean;
  db: number;
  disabled: boolean;
  onSetStream: HeadsetActions['onSetStream'];
}) {
  return (
    <td className={on ? 'hp-cell' : 'hp-cell off'}>
      <div className="control">
        <button
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={`${sourceName} in Stream`}
          disabled={disabled}
          onClick={() => onSetStream({ source: sourceKey, on: !on })}
        />
        <ThrottledRange
          label={`${sourceName} level in Stream`}
          value={db}
          min={STREAM_MIN_DB}
          max={STREAM_MAX_DB}
          step={0.5}
          disabled={disabled || !on}
          format={formatDb}
          onChange={(v) => onSetStream({ source: sourceKey, db: v })}
        />
      </div>
    </td>
  );
});

/** The source row header: label, origin hint, badges, and inline rename. */
function SourceHead({
  sourceKey,
  name,
  detail,
  kind,
  live,
  disabled,
  onRenameSource,
}: {
  sourceKey: SourceKey;
  name: string;
  detail?: string;
  kind: 'mic' | 'camera' | 'obs';
  live: boolean;
  disabled: boolean;
  onRenameSource: HeadsetActions['onRenameSource'];
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const start = () => {
    setValue(name);
    setEditing(true);
  };
  const commit = () => {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed !== name) onRenameSource({ source: sourceKey, name: trimmed === '' ? null : trimmed });
  };
  if (editing) {
    return (
      <th scope="row" className="hp-source">
        <input
          className="hp-rename"
          aria-label={`Rename ${name}`}
          value={value}
          maxLength={60}
          disabled={disabled}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </th>
    );
  }
  return (
    <th scope="row" className="hp-source">
      {name}
      {kind === 'obs' && <span className="small muted"> · OBS</span>}
      {kind === 'camera' && (
        <span className="badge" title="Camera audio">
          camera
        </span>
      )}
      {!live && (
        <span className="badge" title="Off-screen or silent right now">
          silent
        </span>
      )}
      <button className="link" disabled={disabled} onClick={start} aria-label={`Rename ${name}`}>
        Rename
      </button>
      {detail && <div className="small muted">{detail}</div>}
    </th>
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

/** One row per source, a stream column, and one column per headset: who hears what, and how loud. */
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
        {noPlugin && state.pluginPending && (
          <p className="small conn-error" role="alert">
            The Audio Monitor plugin is installed; restart OBS to activate headset mixes. The Stream column already
            works.
          </p>
        )}
        {noPlugin && !state.pluginPending && (
          <p className="small conn-error" role="alert">
            Headset mixes need the Audio Monitor plugin in OBS. The Stream column works without it.{' '}
            <a href={AUDIO_MONITOR_URL} target="_blank" rel="noreferrer">
              Install Audio Monitor
            </a>
            , then restart OBS.
          </p>
        )}
      </div>
      {(state.headsets.length > 0 || state.sources.length > 0) && (
        <div className="group-row hp-scroll">
          <table className="hp-matrix">
            <thead>
              <tr>
                <th scope="col" className="hp-source">
                  Source
                </th>
                <th scope="col" className="hp-head" aria-label="Stream">
                  <div className="hp-title">
                    <strong>Stream</strong>
                  </div>
                  <p className="small muted">what the broadcast hears</p>
                </th>
                {state.headsets.map((h) => (
                  <HeadsetHead
                    key={h.id}
                    h={h}
                    headsets={state.headsets}
                    mics={mics}
                    outputs={state.outputs}
                    disabled={disabled}
                    actions={actions}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {state.sources.map((source) => {
                const name = state.labels[source.key] ?? source.name;
                const stream = state.stream[source.key] ?? DEFAULT_SEND;
                return (
                  <tr key={source.key}>
                    <SourceHead
                      sourceKey={source.key}
                      name={name}
                      detail={source.detail}
                      kind={source.kind}
                      live={source.live}
                      disabled={disabled}
                      onRenameSource={actions.onRenameSource}
                    />
                    <StreamCell
                      sourceKey={source.key}
                      sourceName={name}
                      on={stream.on}
                      db={stream.db}
                      disabled={disabled}
                      onSetStream={actions.onSetStream}
                    />
                    {state.headsets.map((h) => {
                      const send = h.sends[source.key] ?? DEFAULT_SEND;
                      return (
                        <SendCell
                          key={h.id}
                          headsetId={h.id}
                          headsetName={h.name}
                          sourceKey={source.key}
                          sourceName={name}
                          on={send.on}
                          db={send.db}
                          self={h.owner !== null && source.key === `mic:${h.owner}`}
                          mirrored={h.mirror !== null}
                          disabled={disabled}
                          onSetSend={actions.onSetSend}
                        />
                      );
                    })}
                  </tr>
                );
              })}
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
