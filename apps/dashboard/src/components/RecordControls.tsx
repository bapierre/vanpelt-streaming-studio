import type { RecordingSession } from '@streamhub/shared';
import { isRecording } from '../recording';
import { formatUptime } from '../state';
import { useConfirm } from '../useConfirm';
import { useNow } from './StatusBar';

function RecBadge({ recording }: { recording: RecordingSession }) {
  const now = useNow(1000);
  if (recording.output === 'paused') return <span className="rec-badge paused">Paused</span>;
  return (
    <span className="rec-badge">
      Rec{recording.startedAt !== undefined && <span className="uptime">{formatUptime(now - recording.startedAt)}</span>}
    </span>
  );
}

type Props = {
  recording: RecordingSession | null;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  confirmMs?: number;
  minConfirmMs?: number;
};

/** Starting is one click; stopping needs a second click, so a stray click never ends the take. */
export function RecordControls({ recording, disabled, onStart, onStop, confirmMs, minConfirmMs }: Props) {
  const active = isRecording(recording);
  const { armed, click } = useConfirm({ confirmMs, minConfirmMs, resetKey: active });
  const changing = recording?.output === 'starting' || recording?.output === 'stopping';
  const label = active ? (armed ? 'Click again to STOP recording' : 'Stop recording') : 'Record';
  return (
    <div className="stream-controls">
      {!disabled && active && recording && <RecBadge recording={recording} />}
      <button
        className={`go-live record ${active ? 'danger' : ''}${armed ? ' armed' : ''}`}
        disabled={disabled || changing || recording === null}
        title={recording?.detail}
        onClick={() => (active ? click(onStop) : onStart())}
      >
        {!active && <span className="rec-dot" aria-hidden />}
        {label}
      </button>
    </div>
  );
}
