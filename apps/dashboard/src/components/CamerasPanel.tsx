import type { CameraControl, CameraState, ControlValue } from '@streamhub/shared';
import { canTake, isObsControl, STATUS_LABEL } from '../cameras';
import { ThrottledRange } from './ThrottledRange';
import { Panel } from './ui';

export { RANGE_SEND_MS } from './ThrottledRange';

type Actions = {
  onTake: (id: string) => void;
  onSet: (id: string, key: string, value: ControlValue) => void;
};

/** Live-tab camera cuts: one row per camera, take with a click. */
export function CameraSwitcher({ cameras, disabled, onTake }: { cameras: CameraState[]; disabled: boolean } & Pick<Actions, 'onTake'>) {
  if (cameras.length === 0) return null;
  return (
    <Panel title="Cameras" sub="Click to take">
      <div className="cam-rows">
        {cameras.map((cam) => (
          <button
            key={cam.id}
            className={cam.onAir ? 'cam-row on-air' : 'cam-row'}
            aria-pressed={cam.onAir}
            disabled={disabled || !canTake(cam)}
            title={cam.obsDetail ?? cam.detail ?? STATUS_LABEL[cam.status]}
            onClick={() => onTake(cam.id)}
          >
            <span className={`dot cam-${cam.status}`} aria-hidden />
            <span className="cam-row-name">{cam.name}</span>
            {cam.telemetry?.overheating && <span className="cam-warn">hot</span>}
            <span className="spacer" />
            {cam.onAir ? <span className="pill live">On air</span> : <span className="cam-take">Take</span>}
          </button>
        ))}
      </div>
    </Panel>
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
  return (
    <ThrottledRange
      id={id}
      value={c.value}
      min={c.min}
      max={c.max}
      step={c.step}
      disabled={disabled}
      format={(v) => (Number.isInteger(c.step) ? String(v) : v.toFixed(2))}
      onChange={(v) => onSet(c.key, v)}
    />
  );
}
