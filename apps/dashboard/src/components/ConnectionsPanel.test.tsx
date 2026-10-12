// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionCard, needsAttention, type ConnectionActions } from './ConnectionsPanel';

afterEach(cleanup);

const actions = (): ConnectionActions => ({
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  onSetTwitchClient: vi.fn(),
  onSetYoutubeClient: vi.fn(),
  onSetXClient: vi.fn(),
});
const card = (platform: 'twitch' | 'youtube' | 'x' | 'kick', state: object, extra: object = {}) =>
  render(<ConnectionCard platform={platform} state={state as never} actions={actions()} {...extra} />);

describe('ConnectionCard', () => {
  it('marks an unconfigured platform Not set up and shows the one-time box instead of a Connect button', () => {
    card('twitch', { platform: 'twitch', state: 'disconnected', clientConfigured: false });
    expect(screen.getByText('Not set up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByText('One-time step: give streamhub your Twitch app')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Twitch console' }).getAttribute('href')).toBe('https://dev.twitch.tv/console');
  });

  it('saves a trimmed Twitch client id and connects once the hub confirms it is saved', async () => {
    const h = actions();
    const state = { platform: 'twitch' as const, state: 'disconnected' as const, clientConfigured: false };
    const { rerender } = render(<ConnectionCard platform="twitch" state={state} actions={h} />);
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' cid ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(h.onSetTwitchClient).toHaveBeenCalledWith('cid');
    expect(h.onConnect).not.toHaveBeenCalled();
    rerender(<ConnectionCard platform="twitch" state={{ ...state, clientConfigured: true, state: 'disconnected' }} actions={h} />);
    expect(h.onConnect).toHaveBeenCalledWith();
    rerender(<ConnectionCard platform="twitch" state={{ ...state, clientConfigured: true, state: 'pending', userCode: 'ABCDEFGH' }} actions={h} />);
    await screen.findByText('ABCDEFGH');
  });

  it('shows the Twitch code and activation link while pending', () => {
    card('twitch', {
      platform: 'twitch',
      state: 'pending',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
    });
    expect(screen.getByText('ABCDEFGH')).toBeTruthy();
    const link = screen.getByRole('link', { name: /twitch\.tv\/activate/ });
    expect(link.getAttribute('href')).toBe('https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('connects and disconnects Twitch', () => {
    const h = actions();
    const { rerender } = render(
      <ConnectionCard platform="twitch" state={{ platform: 'twitch', state: 'disconnected', clientConfigured: true }} actions={h} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(h.onConnect).toHaveBeenCalledWith();
    rerender(<ConnectionCard platform="twitch" state={{ platform: 'twitch', state: 'connected', account: 'yatf' }} actions={h} />);
    expect(screen.getByText('Signed in as yatf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(h.onDisconnect).toHaveBeenCalledWith();
  });

  it('asks for the YouTube client, submits trimmed values and clears the secret field', () => {
    const h = actions();
    render(
      <ConnectionCard platform="youtube" state={{ platform: 'youtube', state: 'disconnected', clientConfigured: false }} actions={h} />,
    );
    const id = screen.getByLabelText('Client ID') as HTMLInputElement;
    const secret = screen.getByLabelText('Client secret') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(id, { target: { value: ' cid ' } });
    fireEvent.change(secret, { target: { value: ' s3 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }));
    expect(h.onSetYoutubeClient).toHaveBeenCalledWith('cid', 's3');
    expect(secret.value).toBe('');
  });

  it('links the Google sign-in only when it is https', () => {
    const { rerender } = render(
      <ConnectionCard
        platform="youtube"
        state={{ platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }}
        actions={actions()}
      />,
    );
    expect(screen.getByRole('link', { name: 'Continue to Google sign-in' }).getAttribute('href')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    );
    rerender(
      <ConnectionCard
        platform="youtube"
        state={{ platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: 'javascript:alert(1)' }}
        actions={actions()}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Continue to Google sign-in' })).toBeNull();
  });

  it('keeps the YouTube policy links beside the connect flow', () => {
    card('youtube', { platform: 'youtube', state: 'error', clientConfigured: true, detail: 'YouTube sign-in expired. Reconnect it.' });
    expect(screen.getByText(/sign-in expired/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'YouTube Terms of Service' }).getAttribute('href')).toBe('https://www.youtube.com/t/terms');
    expect(screen.getByRole('link', { name: 'Google Privacy Policy' }).getAttribute('href')).toBe('https://policies.google.com/privacy');
  });

  it('offers Connect on a card whose auth was lost, and asks for the X client id first', () => {
    const h = actions();
    const { rerender } = render(
      <ConnectionCard platform="x" state={{ platform: 'x', state: 'error', clientConfigured: true, detail: 'X sign-in expired. Reconnect it.' }} actions={h} />,
    );
    expect(screen.getByText('Error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(h.onConnect).toHaveBeenCalledWith();
    rerender(<ConnectionCard platform="x" state={{ platform: 'x', state: 'disconnected', clientConfigured: false }} actions={h} />);
    fireEvent.change(screen.getByLabelText('OAuth 2.0 Client ID'), { target: { value: ' xid ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }));
    expect(h.onSetXClient).toHaveBeenCalledWith('xid');
  });

  it('links the X sign-in once a client exists', () => {
    card('x', { platform: 'x', state: 'pending', clientConfigured: true, authUrl: 'https://x.com/i/oauth2/authorize?a=1' });
    expect(screen.getByRole('link', { name: 'Continue to X sign-in' }).getAttribute('href')).toBe('https://x.com/i/oauth2/authorize?a=1');
  });

  it('explains what X reports once connected', () => {
    render(
      <ConnectionCard
        platform="x"
        state={{ platform: 'x', state: 'connected', clientConfigured: true, account: '@yatf' }}
        live={{ platform: 'x', ingest: 'active', broadcast: 'running', viewers: 1200 }}
        actions={actions()}
      />,
    );
    expect(screen.getByText('Signed in as @yatf')).toBeTruthy();
    expect(screen.getByText(/Live · 1\.2K watching/)).toBeTruthy();
    expect(screen.getByText(/Receiving video/)).toBeTruthy();
    expect(screen.getByText('Livestream status')).toBeTruthy();
  });

  it('marks Kick as coming later, with no connect button', () => {
    card('kick', { platform: 'kick', state: 'disconnected', detail: 'Kick arrives with the relay (M3).' });
    expect(screen.getByText('Coming later')).toBeTruthy();
    expect(screen.getByText(/Until then, save the stream key below/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('lets a pending connection be started again', () => {
    const h = actions();
    render(
      <ConnectionCard
        platform="twitch"
        state={{ platform: 'twitch', state: 'pending', userCode: 'ABCDEFGH', clientConfigured: true }}
        actions={h}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(h.onConnect).toHaveBeenCalledWith();
  });
});

describe('needsAttention', () => {
  it('flags error, pending and unconfigured platforms, not a plain disconnect', () => {
    expect(needsAttention({ platform: 'twitch', state: 'error' })).toBe(true);
    expect(needsAttention({ platform: 'twitch', state: 'pending' })).toBe(true);
    expect(needsAttention({ platform: 'twitch', state: 'disconnected', clientConfigured: false })).toBe(true);
    expect(needsAttention({ platform: 'twitch', state: 'disconnected', clientConfigured: true })).toBe(false);
    expect(needsAttention({ platform: 'kick', state: 'disconnected', detail: 'M3' })).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });
});
