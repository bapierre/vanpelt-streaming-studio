import { useEffect, useState } from 'react';
import type { AudioDevices, AudioState, HeadsetsState, MicState } from '@streamhub/shared';
import { micWarning } from '../audio';
import type { LevelsStore } from '../levels';
import { AddMic, Fader, LiveMeter, MicCard, MuteButton, recordingSummary, type AudioActions } from './AudioPanel';
import { HeadsetMatrix, type HeadsetActions } from './HeadsetMatrix';
import { Sheet } from './Sheet';
import { Pill } from './ui';

const sideLabel = (mic: MicState) => (mic.channel === 'left' ? ', left side' : mic.channel === 'right' ? ', right side' : '');

/** One mic card on the Mics page: status, track, meter, fader, and the buttons you need mid-show. */
function Strip({
  mic,
  levels,
  selected,
  disabled,
  actions,
  onOpen,
}: {
  mic: MicState;
  levels: LevelsStore;
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
      <div className="strip-head">
        <span className={mic.live && mic.status === 'ok' ? 'dot ok' : 'dot'} aria-hidden />
        <button className="strip-name" aria-pressed={selected} aria-label={`Open ${mic.name}`} onClick={onOpen}>
          {mic.name}
        </button>
        <Pill tone={mic.track === null ? 'off' : 'accent'}>{mic.track === null ? 'Mix only' : `Track ${mic.track}`}</Pill>
      </div>
      <div className="strip-meta">
        <span className="strip-device small muted">
          {mic.input}
          {sideLabel(mic)}
        </span>
        {mic.live && mic.status === 'ok' && <Pill tone="live">On air</Pill>}
        {warning && <span className="cam-warn" title={warning}>!</span>}
      </div>
      <LiveMeter store={levels} id={mic.id} />
      <div className="control">
        <Fader mic={mic} disabled={off} onSet={actions.onSet} />
      </div>
      <div className="strip-actions">
        <MuteButton mic={mic} disabled={off} onSet={actions.onSet} />
        <button
          className="sm"
          aria-label={listening ? `Cancel sound check for ${mic.name}` : `Sound check ${mic.name}`}
          disabled={disabled || (!listening && mic.status !== 'ok')}
          onClick={() => actions.onSoundcheck(mic.id, listening ? 'cancel' : 'start')}
        >
          {listening ? 'Listening…' : 'Sound check'}
        </button>
      </div>
      {mic.status === 'ok' && !mic.live && (
        <button className="link small" disabled={disabled} onClick={actions.onNest} title="Puts the streamhub mics scene into every scene">
          Add mics to all scenes
        </button>
      )}
    </div>
  );
}

/** Recording tracks as pills: the stream mix first, then one pill per mic track. */
function TrackPills({ state }: { state: AudioState }) {
  const names = new Map(state.mics.filter((m) => m.track !== null).map((m) => [m.track, m.name]));
  return (
    <span className="tracks" title={recordingSummary(state)}>
      <span className="tracks-label small muted">Recording tracks</span>
      {state.recordTracks.map((t) => (
        <Pill key={t} tone={t === 1 ? 'off' : 'accent'}>
          {t} {t === 1 ? 'Stream mix' : (names.get(t) ?? '?')}
        </Pill>
      ))}
    </span>
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
  levels: LevelsStore;
  headsets: HeadsetsState | null;
  /** OBS is not reachable: nothing can change in OBS. */
  disabled: boolean;
  /** Headset config is kept by the hub, so it can change while OBS is away. */
  hubConnected: boolean;
  actions: AudioActions;
  headsetActions: HeadsetActions;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { onListDevices } = actions;
  useEffect(() => {
    if (!disabled) onListDevices();
    // Only when the tab opens or the hub comes back, not on every render.
  }, [disabled]);
  if (!state) return <p className="muted sound-wait">Waiting for the hub…</p>;
  const selected = state.mics.find((m) => m.id === open) ?? null;
  return (
    <div className="sound">
      <div className="sound-main">
        <div className="sound-head">
          <h1>Mics</h1>
          <span className="spacer" />
          <TrackPills state={state} />
        </div>
        {state.tracksPending && <p className="small muted">Track changes apply to the next recording.</p>}
        {state.recordDetail && (
          <p className="small conn-error" role="alert">
            {state.recordDetail}
          </p>
        )}
        <div className="strips">
          {state.mics.length === 0 && <p className="strips-empty muted">No mics yet. Each mic you add gets its own recording track.</p>}
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
          <button className="add-strip" onClick={() => setAdding(true)}>
            + Add a mic
          </button>
        </div>
        <HeadsetMatrix state={headsets} mics={state.mics} disabled={!hubConnected} actions={headsetActions} />
      </div>
      <aside className="sound-detail" aria-label="Voice settings">
        {selected ? (
          <MicCard
            mic={selected}
            levels={levels}
            targetDb={state.targetDb}
            disabled={disabled}
            actions={actions}
            onClose={() => setOpen(null)}
          />
        ) : (
          <p className="small muted detail-hint">Click a mic to tune its voice: gain, noise removal, EQ, dynamics and sync.</p>
        )}
      </aside>
      <Sheet open={adding} title="Add a mic" onClose={() => setAdding(false)}>
        <AddMic devices={devices} disabled={disabled} actions={actions} onAdded={() => setAdding(false)} />
      </Sheet>
    </div>
  );
}
