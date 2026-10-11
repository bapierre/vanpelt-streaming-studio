import { useEffect, useRef, useState } from 'react';
import { formatUptime, type DashboardState } from '../state';
import { useNow } from './StatusBar';

function OnAir({ stream }: { stream: DashboardState['stream'] }) {
  const now = useNow(1000);
  if (stream.state !== 'live') return <span className="on-air off">{stream.state === 'stopped' ? 'Off air' : stream.state}</span>;
  return (
    <span className="on-air">
      Live{stream.startedAt !== undefined && <span className="uptime">{formatUptime(now - stream.startedAt)}</span>}
    </span>
  );
}

type Props = {
  stream: DashboardState['stream'];
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  confirmMs?: number;
  /** Confirming clicks faster than this are ignored, so a double-click never fires. */
  minConfirmMs?: number;
};

export function StreamControls({
  stream,
  disabled,
  onStart,
  onStop,
  confirmMs = 4000,
  minConfirmMs = 500,
}: Props) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), confirmMs);
    return () => clearTimeout(t);
  }, [armed, confirmMs]);

  const live = stream.state === 'live' || stream.state === 'starting';

  // If the stream flips (e.g. started from OBS) while armed, the confirm would do the opposite.
  useEffect(() => {
    setArmed(false);
  }, [live]);
  const changing = stream.state === 'starting' || stream.state === 'stopping';
  const label = armed
    ? live
      ? 'Click again to STOP stream'
      : 'Click again to GO LIVE'
    : live
      ? 'Stop stream'
      : 'Start stream';

  const onClick = () => {
    if (!armed) {
      armedAt.current = Date.now();
      setArmed(true);
      return;
    }
    if (Date.now() - armedAt.current < minConfirmMs) return;
    setArmed(false);
    if (live) onStop();
    else onStart();
  };

  return (
    <div className="stream-controls">
      {!disabled && <OnAir stream={stream} />}
      <button
        className={`go-live ${live ? 'danger' : 'primary'}${armed ? ' armed' : ''}`}
        disabled={disabled || changing}
        onClick={onClick}
      >
        {label}
      </button>
    </div>
  );
}
