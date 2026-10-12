import { useEffect, useState, type FormEvent } from 'react';
import type { DashboardState } from '../state';
import { Icon } from './Icon';
import { SecretInput } from './Secret';
import { Panel, Pill } from './ui';

const DEFAULT_URL = 'ws://127.0.0.1:4455';

/** The OBS page: connection status, the server address, and the two buttons that revive it. */
export function ObsSettings({
  obs,
  settings,
  onSave,
  onReconnect,
  onRefresh,
}: {
  obs: DashboardState['obs'];
  settings: DashboardState['obsSettings'];
  onSave: (url: string, password: string | undefined) => void;
  onReconnect: () => void;
  onRefresh: () => void;
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
    <Panel
      className="connection-card"
      title="Connection"
      sub="Scenes, mics and Go live come through OBS's websocket server"
      label="OBS: Connection"
      actions={<Pill tone={obs.connected ? 'ok' : 'bad'} dot>{obs.connected ? 'Connected' : 'Offline'}</Pill>}
    >
      <div className="card-body">
        {obs.detail && <p className={obs.connected ? 'muted small' : 'conn-error'}>{obs.detail}</p>}
        <div className="card-actions">
          <button className="ghost" disabled={!obs.connected} onClick={onRefresh}>
            <Icon name="refresh" />
            Refresh scenes and sources
          </button>
          <button onClick={onReconnect}>Reconnect</button>
        </div>
        <form className="destination-form" onSubmit={submit}>
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
      </div>
    </Panel>
  );
}
