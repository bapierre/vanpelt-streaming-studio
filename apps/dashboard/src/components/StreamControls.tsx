import { formatUptime, type DashboardState } from '../state';
import { useConfirm } from '../useConfirm';
import { useNow } from '../useNow';

function Uptime({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return <span className="uptime">{formatUptime(now - startedAt)}</span>;
}

type Props = {
  stream: DashboardState['stream'];
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  /** Pre-flight problems; going live still works, but the confirm says so. */
  problems?: number;
  confirmMs?: number;
  /** Confirming clicks faster than this are ignored, so a double-click never fires. */
  minConfirmMs?: number;
};

export function StreamControls({
  stream,
  disabled,
  onStart,
  onStop,
  problems = 0,
  confirmMs = 4000,
  minConfirmMs = 500,
}: Props) {
  const live = stream.state === 'live' || stream.state === 'starting';
  // If the stream flips (e.g. started from OBS) while armed, the confirm would do the opposite.
  const { armed, click } = useConfirm({ confirmMs, minConfirmMs, resetKey: live });
  const changing = stream.state === 'starting' || stream.state === 'stopping';
  const label = armed
    ? live
      ? 'Click again to END stream'
      : problems > 0
        ? 'Click again to GO LIVE anyway'
        : 'Click again to GO LIVE'
    : stream.state === 'starting'
      ? 'Starting…'
      : stream.state === 'stopping'
        ? 'Ending…'
        : live
          ? 'End stream'
          : 'Go live';

  const button = (
    <button
      className={`go-live${armed ? ' armed' : ''}`}
      disabled={disabled || changing}
      title={!live && problems > 0 ? `Pre-flight found ${problems} problem${problems === 1 ? '' : 's'}` : undefined}
      onClick={() => click(live ? onStop : onStart)}
    >
      {label}
    </button>
  );

  // While OBS is unreachable its last stream state may be stale, so never claim to be on air.
  if (disabled || !live) return <div className="stream-controls">{button}</div>;
  return (
    <div className="stream-controls on-air" role="group" aria-label="On air">
      <span className="on-air-label">On air</span>
      {stream.state === 'live' && stream.startedAt !== undefined && <Uptime startedAt={stream.startedAt} />}
      {button}
    </div>
  );
}
