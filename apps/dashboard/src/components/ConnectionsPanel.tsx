import { useState, type FormEvent, type ReactNode } from 'react';
import type { ConnectionState, Platform, PlatformLive } from '@streamhub/shared';
import { PLATFORMS, platformColor } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';
import { PlatformLiveDetail } from './PlatformLive';
import { SecretInput, SecretText } from './Secret';

type Props = {
  connections: Partial<Record<Platform, ConnectionState>>;
  live?: Partial<Record<Platform, PlatformLive>>;
  onConnect: (platform: Platform) => void;
  onDisconnect: (platform: Platform) => void;
  onSetYoutubeClient: (clientId: string, clientSecret: string) => void;
  onSetXClient: (clientId: string) => void;
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
        <span className="platform-tile" style={platformColor(platform)} aria-hidden>
          {PLATFORMS[platform].label[0]}
        </span>
        <span className="conn-title">
          <strong>{PLATFORMS[platform].label}</strong>
          <span className="conn-sub">
            <span className={`conn-state ${s}`}>{s}</span>
            {state?.account && <span>{state.account}</span>}
          </span>
        </span>
        <span className="spacer" />
        {s === 'connected' ? (
          <button onClick={onDisconnect}>Disconnect</button>
        ) : (
          <button className="primary" onClick={onConnect} disabled={disabled}>
            {s === 'pending' ? 'Start again' : 'Connect'}
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
      <label className="field">
        <span className="field-label">Client ID</span>
        <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <SecretInput label="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
      <div className="form-actions">
        <button type="submit">Save client</button>
      </div>
    </form>
  );
}

function XClientForm({ onSave }: { onSave: (id: string) => void }) {
  const [id, setId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (id.trim()) onSave(id.trim());
  };
  return (
    <form className="yt-client" onSubmit={submit}>
      <p className="muted">
        X needs your own X developer app (a few minutes, see <code>docs/setup/x.md</code>). Only its OAuth 2.0 client ID is
        needed, and it is stored only on this computer.
      </p>
      <label className="field">
        <span className="field-label">OAuth 2.0 Client ID</span>
        <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div className="form-actions">
        <button type="submit">Save client</button>
      </div>
    </form>
  );
}

export function ConnectionsPanel({ connections, live = {}, onConnect, onDisconnect, onSetYoutubeClient, onSetXClient }: Props) {
  const [editClient, setEditClient] = useState(false);
  const [editXClient, setEditXClient] = useState(false);
  const x = connections.x;
  const xSignIn = x?.state === 'pending' ? safeHttpsUrl(x.authUrl) : null;
  const showXClientForm = editXClient || x?.clientConfigured === false;
  const twitch = connections.twitch;
  const youtube = connections.youtube;
  const activate = twitch?.state === 'pending' ? safeHttpsUrl(twitch.verificationUri) : null;
  const google = youtube?.state === 'pending' ? safeHttpsUrl(youtube.authUrl) : null;
  const showClientForm = editClient || youtube?.clientConfigured === false;

  return (
    <section className="group connections">
      <Row platform="twitch" state={twitch} onConnect={() => onConnect('twitch')} onDisconnect={() => onDisconnect('twitch')}>
        {twitch?.state === 'pending' && twitch.userCode && (
          <p>
            Go to {activate ? <ExternalLink href={activate}>{activate.replace(/^https:\/\//, '').split('?')[0]!}</ExternalLink> : 'twitch.tv/activate'} and enter{' '}
            <SecretText value={twitch.userCode} label="Twitch code" />
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

      <Row platform="x" state={x} onConnect={() => onConnect('x')} onDisconnect={() => onDisconnect('x')}>
        {xSignIn && (
          <p>
            <ExternalLink href={xSignIn}>Continue to X sign-in</ExternalLink>
          </p>
        )}
        {x?.state === 'connected' && live.x && <PlatformLiveDetail live={live.x} />}
        {showXClientForm ? (
          <XClientForm
            onSave={(id) => {
              onSetXClient(id);
              setEditXClient(false);
            }}
          />
        ) : (
          <button className="link" onClick={() => setEditXClient(true)}>
            Change X app
          </button>
        )}
        <p className="muted small">streamhub only reads your X livestream state. X chat is not pulled in.</p>
      </Row>

      <Row platform="kick" state={connections.kick} onConnect={() => onConnect('kick')} onDisconnect={() => onDisconnect('kick')} disabled />
    </section>
  );
}
