import { useEffect, useState } from 'react';
import { formatUptime, type DashboardState } from '../state';

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const Dot = ({ ok }: { ok: boolean }) => <span className={ok ? 'dot ok' : 'dot bad'} aria-hidden />;

export function StatusBar({ state }: { state: DashboardState }) {
  const now = useNow(1000);
  const { stream } = state;
  const platforms = Object.entries(state.platforms);
  return (
    <footer className="status-bar">
      <span><Dot ok={state.hubConnected} /> Hub</span>
      <span title={state.obs.detail}>
        <Dot ok={state.obs.connected} /> OBS{!state.obs.connected && state.obs.detail ? `: ${state.obs.detail}` : ''}
      </span>
      {state.obs.connected ? (
        <span>
          <Dot ok={stream.state === 'live'} /> {stream.state}
          {stream.state === 'live' && stream.startedAt !== undefined && ` · ${formatUptime(now - stream.startedAt)}`}
        </span>
      ) : (
        <span className="muted">stream unknown</span>
      )}
      {platforms.length === 0 ? (
        <span className="muted">No chat connectors yet</span>
      ) : (
        platforms.map(([platform, p]) => (
          <span key={platform} title={p?.detail}>
            <Dot ok={p?.status === 'live'} /> {platform}: {p?.status}
          </span>
        ))
      )}
    </footer>
  );
}
