import { useEffect, useRef, useState } from 'react';
import type { CameraControl, CameraState, ControlValue } from '@streamhub/shared';
import { canTake, isObsControl, STATUS_LABEL } from '../cameras';

type Actions = {
  onTake: (id: string) => void;
  onSet: (id: string, key: string, value: ControlValue) => void;
};

/** Range changes are sent at most this often while dragging, so a slider cannot flood the camera. */
export const RANGE_SEND_MS = 120;

export function CameraSwitcher({ cameras, disabled, onTake }: { cameras: CameraState[]; disabled: boolean } & Pick<Actions, 'onTake'>) {
  if (cameras.length === 0) return null;
  return (
    <section className="side-section" aria-label="Cameras">
      <h2>Cameras</h2>
      <div className="scene-list">
        {cameras.map((cam) => (
          <button
            key={cam.id}
            className={cam.onAir ? 'scene active' : 'scene'}
            aria-pressed={cam.onAir}
            disabled={disabled || !canTake(cam)}
            title={cam.obsDetail ?? cam.detail ?? STATUS_LABEL[cam.status]}
            onClick={() => onTake(cam.id)}
          >
            <span className={`dot cam-${cam.status}`} />
            <span className="scene-name">{cam.name}</span>
            {cam.telemetry?.overheating && <span className="cam-warn">hot</span>}
            {cam.onAir && <span className="program-badge">On air</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

export function CamerasPanel({ cameras, disabled, onTake, onSet }: { cameras: CameraState[]; disabled: boolean } & Actions) {
  return (
    <section className="cameras">
      {cameras.length === 0 && (
        <p className="muted">
          No cameras configured. Add them to <code>.streamhub/cameras.json</code> and restart the hub (see docs/cameras).
        </p>
      )}
      <div className="camera-grid">
        {cameras.map((cam) => (
          <CameraCard key={cam.id} cam={cam} disabled={disabled} onTake={onTake} onSet={onSet} />
        ))}
      </div>
    </section>
  );
}

function CameraCard({ cam, disabled, onTake, onSet }: { cam: CameraState; disabled: boolean } & Actions) {
  const device = cam.controls.filter((c) => !isObsControl(c));
  const picture = cam.controls.filter((c) => isObsControl(c) && c.key !== 'obs.createScene');
  const create = cam.controls.find((c) => c.key === 'obs.createScene');
  const set = (key: string, value: ControlValue) => onSet(cam.id, key, value);
  return (
    <article className={cam.onAir ? 'camera-card on-air' : 'camera-card'} aria-label={cam.name}>
      <div className="camera-head">
        <h3>{cam.name}</h3>
        <span className={`cam-status cam-${cam.status}`}>{STATUS_LABEL[cam.status]}</span>
        {cam.telemetry?.battery !== undefined && <span className="small muted">battery {cam.telemetry.battery}%</span>}
        {cam.telemetry?.overheating && <span className="cam-warn">overheating</span>}
        <span className="spacer" />
        <button className="primary" disabled={disabled || !canTake(cam)} onClick={() => onTake(cam.id)}>
          {cam.onAir ? 'On air' : 'Take'}
        </button>
      </div>
      <p className="small muted">
        Scene <strong>{cam.scene}</strong>
        {cam.driver ? ` · driver ${cam.driver}` : ' · OBS only'}
      </p>
      {cam.detail && <p className="conn-error small">{cam.detail}</p>}
      {cam.obsDetail && <p className="conn-error small">{cam.obsDetail}</p>}
      {create && <ControlView control={create} idPrefix={cam.id} disabled={disabled} onSet={set} />}
      {device.length > 0 && (
        <ControlGroup title="Camera" controls={device} idPrefix={cam.id} disabled={disabled} onSet={set} />
      )}
      {picture.length > 0 && (
        <ControlGroup title="Picture (OBS)" controls={picture} idPrefix={cam.id} disabled={disabled} onSet={set} />
      )}
    </article>
  );
}

type ControlProps = { idPrefix: string; disabled: boolean; onSet: (key: string, value: ControlValue) => void };

function ControlGroup({ title, controls, ...rest }: { title: string; controls: CameraControl[] } & ControlProps) {
  return (
    <fieldset className="camera-controls">
      <legend>{title}</legend>
      {controls.map((c) => (
        <ControlView key={c.key} control={c} {...rest} />
      ))}
    </fieldset>
  );
}

function ControlView({ control: c, idPrefix, disabled, onSet }: { control: CameraControl } & ControlProps) {
  const off = disabled || c.disabled !== undefined;
  const help = c.disabled ?? c.hint;
  const id = `${idPrefix}-${c.key}`;
  if (c.kind === 'action') {
    return (
      <div className="control">
        <button disabled={off} title={help} onClick={() => onSet(c.key, null)}>
          {c.label}
        </button>
        {help && <span className="small muted">{help}</span>}
      </div>
    );
  }
  return (
    <div className="control" title={help}>
      <label htmlFor={id}>{c.label}</label>
      {c.kind === 'select' && (
        <select id={id} value={c.value} disabled={off} onChange={(e) => onSet(c.key, e.target.value)}>
          {!c.options.some((o) => o.value === c.value) && <option value={c.value}>—</option>}
          {c.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {c.kind === 'toggle' && (
        <input id={id} type="checkbox" role="switch" checked={c.value} disabled={off} onChange={(e) => onSet(c.key, e.target.checked)} />
      )}
      {c.kind === 'range' && <RangeInput id={id} control={c} disabled={off} onSet={onSet} />}
      {help && <span className="small muted control-help">{help}</span>}
    </div>
  );
}

function RangeInput({
  id,
  control: c,
  disabled,
  onSet,
}: {
  id: string;
  control: Extract<CameraControl, { kind: 'range' }>;
  disabled: boolean;
  onSet: (key: string, value: ControlValue) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(c.value);
  useEffect(() => () => clearTimeout(pending.current ?? undefined), []);
  const change = (v: number) => {
    setLocal(v);
    latest.current = v;
    pending.current ??= setTimeout(() => {
      pending.current = null;
      onSet(c.key, latest.current);
    }, RANGE_SEND_MS);
  };
  // Show the dragged value until the hub answers, then follow the hub (it may have clamped the value).
  const value = local ?? c.value;
  useEffect(() => {
    if (pending.current === null) setLocal(null);
  }, [c.value]);
  return (
    <>
      <input
        id={id}
        type="range"
        min={c.min}
        max={c.max}
        step={c.step}
        value={value}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
      />
      <output htmlFor={id} className="small">
        {Number.isInteger(c.step) ? value : value.toFixed(2)}
      </output>
    </>
  );
}
