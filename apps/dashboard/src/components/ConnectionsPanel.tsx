import { useState, type FormEvent, type ReactNode } from 'react';
import type { ConnectionState, Platform } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';

type Props = {
  connections: Partial<Record<Platform, ConnectionState>>;
  onConnect: (platform: Platform) => void;
  onDisconnect: (platform: Platform) => void;
  onSetYoutubeClient: (clientId: string, clientSecret: string) => void;
};

const ExternalLink = ({ href, children }: { href: string; children: string }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

function Row({ platform, state, children, onConnect, onDisconnect, disabled }: {
  platform: Platform;
  state: ConnectionState | undefined;
  children?: ReactNode;
  onConnect: () => void;
  onDisconnect: () => void;
  disabled?: boolean;
}) {
  const s = state?.state ?? 'disconnected';
  return (
    <div className="conn" data-testid={`conn-${platform}`}>
      <div className="conn-head">
        <span className="tag" style={{ background: PLATFORMS[platform].color }}>
          {PLATFORMS[platform].label}
        </span>
        <span className={`conn-state ${s}`}>{s}</span>
        {state?.account && <strong>{state.account}</strong>}
        <span className="spacer" />
        {s === 'connected' ? (
          <button onClick={onDisconnect}>Disconnect</button>
        ) : (
          <button className="primary" onClick={onConnect} disabled={disabled || s === 'pending'}>
            Connect
          </button>
        )}
      </div>
      {state?.detail && <p className={s === 'error' ? 'conn-error' : 'muted'}>{state.detail}</p>}
      {children}
    </div>
  );
}

function YouTubeClientForm({ onSave }: { onSave: (id: string, secret: string) => void }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !secret.trim()) return;
    onSave(id.trim(), secret.trim());
    setSecret('');
  };
  return (
    <form className="yt-client" onSubmit={submit}>
      <p className="muted">
        YouTube needs your own Google OAuth client (about 5 minutes, see <code>docs/setup/youtube.md</code>). It is
        stored only on this computer.
      </p>
      <label>
        Client ID
        <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Client secret
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
      </label>
      <button type="submit">Save client</button>
    </form>
  );
}

export function ConnectionsPanel({ connections, onConnect, onDisconnect, onSetYoutubeClient }: Props) {
  const [editClient, setEditClient] = useState(false);
  const twitch = connections.twitch;
  const youtube = connections.youtube;
  const activate = twitch?.state === 'pending' ? safeHttpsUrl(twitch.verificationUri) : null;
  const google = youtube?.state === 'pending' ? safeHttpsUrl(youtube.authUrl) : null;
  const showClientForm = editClient || youtube?.clientConfigured === false;

  return (
    <section className="panel connections">
      <h2>Connections</h2>

      <Row platform="twitch" state={twitch} onConnect={() => onConnect('twitch')} onDisconnect={() => onDisconnect('twitch')}>
        {twitch?.state === 'pending' && twitch.userCode && (
          <p>
            Go to {activate ? <ExternalLink href={activate}>{activate.replace(/^https:\/\//, '').split('?')[0]!}</ExternalLink> : 'twitch.tv/activate'} and enter{' '}
            <code className="code">{twitch.userCode}</code>
          </p>
        )}
      </Row>

      <Row platform="youtube" state={youtube} onConnect={() => onConnect('youtube')} onDisconnect={() => onDisconnect('youtube')}>
        {google && (
          <p>
            <ExternalLink href={google}>Continue to Google sign-in</ExternalLink>
          </p>
        )}
        {showClientForm ? (
          <YouTubeClientForm
            onSave={(id, secret) => {
              onSetYoutubeClient(id, secret);
              setEditClient(false);
            }}
          />
        ) : (
          <button className="link" onClick={() => setEditClient(true)}>
            Change Google client
          </button>
        )}
        <p className="muted small">
          By connecting YouTube you agree to the <ExternalLink href="https://www.youtube.com/t/terms">YouTube Terms of Service</ExternalLink>. See
          the <ExternalLink href="https://policies.google.com/privacy">Google Privacy Policy</ExternalLink>. Chat is kept in memory only.
        </p>
      </Row>

      <Row platform="kick" state={connections.kick} onConnect={() => onConnect('kick')} onDisconnect={() => onDisconnect('kick')} disabled />
    </section>
  );
}
