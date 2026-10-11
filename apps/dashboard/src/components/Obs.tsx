import { useEffect, useState, type FormEvent } from 'react';
import type { DashboardState } from '../state';
import { Icon } from './Icon';
import { SecretInput } from './Secret';

const DEFAULT_URL = 'ws://127.0.0.1:4455';

export function ObsTools({
  obs,
  hubConnected,
  onRefresh,
  onReconnect,
}: {
  obs: DashboardState['obs'];
  hubConnected: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
}) {
  return (
    <div className="obs-tools" role="group" aria-label="OBS">
      <span className={obs.connected ? 'obs-status ok' : 'obs-status bad'} title={obs.detail}>
        <span className="dot" aria-hidden />
        {obs.connected ? 'OBS' : 'OBS offline'}
      </span>
      <button className="icon-button" aria-label="Refresh scenes and sources" title="Refresh scenes and sources" disabled={!hubConnected || !obs.connected} onClick={onRefresh}>
        <Icon name="refresh" />
      </button>
      <button className="icon-button" aria-label="Reconnect OBS" title="Reconnect OBS" disabled={!hubConnected} onClick={onReconnect}>
        <Icon name="reconnect" />
      </button>
    </div>
  );
}

export function ObsSettings({
  obs,
  settings,
  onSave,
  onReconnect,
}: {
  obs: DashboardState['obs'];
  settings: DashboardState['obsSettings'];
  onSave: (url: string, password: string | undefined) => void;
  onReconnect: () => void;
}) {
  const [url, setUrl] = useState(settings?.url ?? DEFAULT_URL);
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (settings) setUrl(settings.url);
  }, [settings]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^wss?:\/\/\S+$/.test(url.trim())) return;
    onSave(url.trim(), password === '' ? undefined : password);
    setPassword('');
  };

  return (
    <section className="group">
      <div className="group-row">
        <span className={obs.connected ? 'obs-status ok' : 'obs-status bad'}>
          <span className="dot" aria-hidden />
          {obs.connected ? 'Connected to OBS' : `Not connected${obs.detail ? `: ${obs.detail}` : ''}`}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onReconnect}>
          Reconnect
        </button>
      </div>
      <form className="group-row form" onSubmit={submit}>
        <p className="muted small">
          In OBS open Tools → WebSocket Server Settings, tick Enable WebSocket server, then use Show Connect Info.
        </p>
        <label className="field">
          <span className="field-label">Server address</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={DEFAULT_URL} spellCheck={false} autoComplete="off" />
        </label>
        <SecretInput
          label="Server password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={settings?.passwordSet ? 'Saved. Leave empty to keep it.' : 'No password'}
          autoComplete="new-password"
        />
        <div className="form-actions">
          <button type="submit" className="primary">
            Save and connect
          </button>
        </div>
      </form>
    </section>
  );
}
