import { useEffect, useState } from 'react';
import type { DashboardState } from '../state';

type Props = {
  stream: DashboardState['stream'];
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  confirmMs?: number;
};

export function StreamControls({ stream, disabled, onStart, onStop, confirmMs = 4000 }: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), confirmMs);
    return () => clearTimeout(t);
  }, [armed, confirmMs]);

  const live = stream.state === 'live' || stream.state === 'starting';
  const changing = stream.state === 'starting' || stream.state === 'stopping';
  const label = armed
    ? live
      ? 'Click again to STOP stream'
      : 'Click again to GO LIVE'
    : live
      ? 'Stop stream'
      : 'Start stream';

  const onClick = () => {
    if (!armed) return setArmed(true);
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
