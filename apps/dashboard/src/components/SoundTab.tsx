import { useEffect, useState } from 'react';
import type { AudioDevices, AudioState, HeadsetsState, MicState } from '@streamhub/shared';
import { micWarning, trackLabel, type Levels } from '../audio';
import { AddMic, Fader, MicCard, MuteButton, Meter, recordingSummary, type AudioActions } from './AudioPanel';
import { HeadsetMatrix, type HeadsetActions } from './HeadsetMatrix';

function Strip({
  mic,
  levels,
  selected,
  disabled,
  actions,
  onOpen,
}: {
  mic: MicState;
  levels: Levels;
  selected: boolean;
  disabled: boolean;
  actions: AudioActions;
  onOpen: () => void;
}) {
  const off = disabled || mic.status !== 'ok';
  const warning = micWarning(mic);
  const listening = mic.soundcheck?.state === 'listening';
  return (
    <div className={selected ? 'strip selected' : 'strip'} title={warning}>
      <button className="strip-name" aria-pressed={selected} aria-label={`Open ${mic.name}`} onClick={onOpen}>
        <span className={mic.live && mic.status === 'ok' ? 'dot ok' : 'dot'} />
        <span className="scene-name">{mic.name}</span>
      </button>
      <div className="strip-badges">
        <span className="badge">{trackLabel(mic)}</span>
        {mic.live && mic.status === 'ok' && <span className="program-badge">On air</span>}
        {warning && <span className="cam-warn">!</span>}
      </div>
      <Meter id={mic.id} levels={levels} />
      <div className="control">
        <Fader mic={mic} disabled={off} onSet={actions.onSet} />
      </div>
      <div className="strip-actions">
        <MuteButton mic={mic} disabled={off} onSet={actions.onSet} />
        <button
          className="mute"
          aria-label={listening ? `Cancel sound check for ${mic.name}` : `Sound check ${mic.name}`}
          disabled={disabled || (!listening && mic.status !== 'ok')}
          onClick={() => actions.onSoundcheck(mic.id, listening ? 'cancel' : 'start')}
        >
          {listening ? 'Listening…' : 'Check'}
        </button>
      </div>
    </div>
  );
}

export function SoundTab({
  state,
  devices,
  levels,
  headsets,
  disabled,
  hubConnected,
  actions,
  headsetActions,
}: {
  state: AudioState | null;
  devices: AudioDevices | null;
  levels: Levels;
  headsets: HeadsetsState | null;
  /** OBS is not reachable: nothing can change in OBS. */
  disabled: boolean;
  /** Headset config is kept by the hub, so it can change while OBS is away. */
  hubConnected: boolean;
  actions: AudioActions;
  headsetActions: HeadsetActions;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { onListDevices } = actions;
  useEffect(() => {
    if (!disabled) onListDevices();
    // Only when the tab opens or the hub comes back, not on every render.
  }, [disabled]);
  if (!state) return <p className="muted">Waiting for the hub…</p>;
  const selected = state.mics.find((m) => m.id === open);
  return (
    <div className="sound">
      <section className="group" aria-label="Mics">
        <div className="group-row form">
          <p className="small">
            OBS records: {recordingSummary(state)}
            {state.tracksPending && <span className="muted"> · track changes apply to the next recording</span>}
          </p>
          {state.recordDetail && <p className="small conn-error">{state.recordDetail}</p>}
          {state.mics.length === 0 ? (
            <p className="muted">No mics yet. Add one below.</p>
          ) : (
            <div className="console">
              {state.mics.map((mic) => (
                <Strip
                  key={mic.id}
                  mic={mic}
                  levels={levels}
                  selected={mic.id === open}
                  disabled={disabled}
                  actions={actions}
                  onOpen={() => setOpen((cur) => (cur === mic.id ? null : mic.id))}
                />
              ))}
            </div>
          )}
          {!selected && state.mics.length > 0 && (
            <p className="small muted">Click a mic's name to tune its voice: gain, noise, EQ, dynamics and sync.</p>
          )}
        </div>
      </section>
      {selected && <MicCard mic={selected} levels={levels} disabled={disabled} actions={actions} />}
      <AddMic devices={devices} disabled={disabled} actions={actions} />
      <h2 className="sound-title">Headsets</h2>
      <HeadsetMatrix state={headsets} mics={state.mics} disabled={!hubConnected} actions={headsetActions} />
    </div>
  );
}
