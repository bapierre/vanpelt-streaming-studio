import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionState, Platform, PlatformLive } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';
import { PlatformLiveDetail } from './PlatformLive';
import { SecretInput, SecretText } from './Secret';
import { Panel, Pill, PlatformLogo } from './ui';

/** The one-time box: what the user must do once before this platform can connect. */
type OneTime = { title: string; steps: React.ReactNode[]; console?: string };

const ONE_TIME: Record<'twitch' | 'youtube' | 'x', OneTime> = {
  twitch: {
    title: 'One-time step: give streamhub your Twitch app',
    steps: [
      <>
        Open the Twitch developer console and register an app. Set Client type to Public. See{' '}
        <code>docs/setup/twitch.md</code>.
      </>,
      'Copy its Client ID and paste it below.',
    ],
    console: 'https://dev.twitch.tv/console',
  },
  youtube: {
    title: 'One-time step: create your Google OAuth client',
    steps: [
      <>
        Create a project, enable the YouTube Data API and add yourself as a test user. See{' '}
        <code>docs/setup/youtube.md</code>.
      </>,
      'Copy the Client ID and Client secret and paste them below.',
    ],
    console: 'https://console.cloud.google.com/',
  },
  x: {
    title: 'One-time step: create your X app',
    steps: [
      <>
        Create an app with Read permissions, Native App type, and the callback URL shown in{' '}
        <code>docs/setup/x.md</code>.
      </>,
      'Copy its OAuth 2.0 Client ID and paste it below.',
    ],
    console: 'https://developer.x.com/console',
  },
};

const ExternalLink = ({ href, children }: { href: string; children: string }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

/** The pill text a card and the sidebar agree on. */
export function connectionStatus(platform: Platform, state: ConnectionState | undefined): { tone: 'ok' | 'warn' | 'bad' | 'off' | 'accent'; label: string } {
  if (platform === 'kick') return { tone: 'off', label: 'Coming later' };
  switch (state?.state) {
    case 'connected':
      return { tone: 'ok', label: 'Connected' };
    case 'pending':
      return { tone: 'accent', label: 'Signing in' };
    case 'error':
      return { tone: 'bad', label: 'Error' };
    default:
      return state?.clientConfigured === false ? { tone: 'off', label: 'Not set up' } : { tone: 'off', label: 'Not connected' };
  }
}

/** True when the sidebar should show the orange dot: the user must act for this platform. */
export function needsAttention(state: ConnectionState | undefined): boolean {
  return state?.state === 'error' || state?.state === 'pending' || state?.clientConfigured === false;
}

export type ConnectionActions = {
  onConnect: () => void;
  onDisconnect: () => void;
  onSetTwitchClient: (clientId: string) => void;
  onSetYoutubeClient: (clientId: string, clientSecret: string) => void;
  onSetXClient: (clientId: string) => void;
};

const CARD_TITLE: Partial<Record<Platform, string>> = { x: 'Livestream status' };
const CARD_SUB: Record<Platform, string> = {
  twitch: 'Follows, subs, cheers, raids and chat messages',
  youtube: 'Super Chats, memberships and chat messages',
  kick: 'Follows, subs and chat messages',
  x: 'Scheduled, running or ended, with the viewer count',
};

/** Chat and alerts (X: livestream state) for one platform, the heart of its Settings page. */
export function ConnectionCard({
  platform,
  state,
  live,
  actions,
}: {
  platform: Platform;
  state: ConnectionState | undefined;
  /** X: what the platform reports about our livestream. */
  live?: PlatformLive;
  actions: ConnectionActions;
}) {
  const s = state?.state ?? 'disconnected';
  const status = connectionStatus(platform, state);
  const title = CARD_TITLE[platform] ?? 'Chat and alerts';
  const twitchActivate = state?.state === 'pending' ? safeHttpsUrl(state.verificationUri) : null;
  const google = state?.state === 'pending' ? safeHttpsUrl(state.authUrl) : null;
  const xSignIn = state?.state === 'pending' ? safeHttpsUrl(state.authUrl) : null;
  // "Save and connect" on Twitch: once the hub confirms the saved id, sign-in starts on its own.
  const [savedClient, setSavedClient] = useState(false);
  useEffect(() => {
    if (platform === 'twitch' && savedClient && state?.clientConfigured && state.state === 'disconnected') {
      setSavedClient(false);
      actions.onConnect();
    }
  }, [platform, savedClient, state, actions]);

  return (
    <Panel
      className="connection-card"
      title={
        <span className="card-title">
          <PlatformLogo platform={platform} size={28} />
          {title}
        </span>
      }
      sub={CARD_SUB[platform]}
      label={`${PLATFORMS[platform].label}: ${title}`}
      actions={<Pill tone={status.tone} dot>{status.label}</Pill>}
    >
      <div className="card-body">
        {state?.account && <p className="card-account">Signed in as {state.account}</p>}
        {platform === 'x' && state?.state === 'connected' && live && <PlatformLiveDetail live={live} />}
        {state?.state === 'pending' && state.userCode && (
          <p className="card-code">
            Go to{' '}
            {twitchActivate ? <ExternalLink href={twitchActivate}>twitch.tv/activate</ExternalLink> : 'twitch.tv/activate'}{' '}
            and enter <SecretText value={state.userCode} label="Twitch code" />
          </p>
        )}
        {google && (
          <p>
            <ExternalLink href={google}>Continue to Google sign-in</ExternalLink>
          </p>
        )}
        {xSignIn && (
          <p>
            <ExternalLink href={xSignIn}>Continue to X sign-in</ExternalLink>
          </p>
        )}
        {state?.detail && <p className={state.state === 'error' ? 'conn-error' : 'muted small'}>{state.detail}</p>}
        {platform === 'kick' ? (
          <p className="muted small">
            Kick arrives with the relay (M3). Until then, save the stream key below and stream to Kick through OBS.
          </p>
        ) : state?.clientConfigured === false ? (
          <SetupBox platform={platform} actions={actions} onSavedTwitchClient={() => setSavedClient(true)} />
        ) : null}
        {platform !== 'kick' && state?.clientConfigured !== false && (
          <div className="card-actions">
            {s === 'connected' ? (
              <button onClick={() => actions.onDisconnect()}>Disconnect</button>
            ) : (
              <button className="primary" onClick={() => actions.onConnect()}>
                {s === 'pending' ? 'Start again' : 'Connect'}
              </button>
            )}
          </div>
        )}
        {platform === 'youtube' && (
          <p className="muted small">
            By connecting YouTube you agree to the <ExternalLink href="https://www.youtube.com/t/terms">YouTube Terms of Service</ExternalLink>. See
            the <ExternalLink href="https://policies.google.com/privacy">Google Privacy Policy</ExternalLink>. Chat is kept in memory only.
          </p>
        )}
        {platform === 'x' && <p className="muted small">streamhub only reads your X livestream state. X chat is not pulled in.</p>}
      </div>
    </Panel>
  );
}

function SetupBox({
  platform,
  actions,
  onSavedTwitchClient,
}: {
  platform: 'twitch' | 'youtube' | 'x';
  actions: ConnectionActions;
  onSavedTwitchClient: () => void;
}) {
  const one = ONE_TIME[platform];
  return (
    <div className="setup-box">
      <h5>{one.title}</h5>
      <ol>
        {one.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <div className="setup-actions">
        {one.console && (
          <a className="button" href={one.console} target="_blank" rel="noopener noreferrer">
            Open {PLATFORMS[platform].label} console
          </a>
        )}
      </div>
      {platform === 'twitch' && (
        <TwitchClientForm
          onSave={(id) => {
            actions.onSetTwitchClient(id);
            onSavedTwitchClient();
          }}
        />
      )}
      {platform === 'youtube' && <YoutubeClientForm onSave={actions.onSetYoutubeClient} />}
      {platform === 'x' && <XClientForm onSave={actions.onSetXClient} />}
    </div>
  );
}

function TwitchClientForm({ onSave }: { onSave: (clientId: string) => void }) {
  const [id, setId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (id.trim()) onSave(id.trim());
  };
  return (
    <form className="client-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Client ID</span>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Paste the Client ID" autoComplete="off" spellCheck={false} />
      </label>
      <div className="form-actions">
        <button type="submit" className="primary">
          Save and connect
        </button>
      </div>
    </form>
  );
}

function YoutubeClientForm({ onSave }: { onSave: (clientId: string, clientSecret: string) => void }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !secret.trim()) return;
    onSave(id.trim(), secret.trim());
    setSecret('');
  };
  return (
    <form className="client-form" onSubmit={submit}>
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

function XClientForm({ onSave }: { onSave: (clientId: string) => void }) {
  const [id, setId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (id.trim()) onSave(id.trim());
  };
  return (
    <form className="client-form" onSubmit={submit}>
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
