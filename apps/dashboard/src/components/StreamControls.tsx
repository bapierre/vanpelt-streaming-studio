import { useEffect, useRef, useState } from 'react';
import type { DashboardState } from '../state';

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
      <button className={live ? 'danger' : 'primary'} disabled={disabled || changing} onClick={onClick}>
        {label}
      </button>
      <p className="hint">
        Other platforms (multi-rtmp targets) follow OBS only if “Sync start/stop with OBS” is ticked.
      </p>
    </div>
  );
}
