// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPanel } from './ConnectionsPanel';

afterEach(cleanup);

const handlers = () => ({ onConnect: vi.fn(), onDisconnect: vi.fn(), onSetYoutubeClient: vi.fn() });

describe('ConnectionsPanel', () => {
  it('shows the Twitch code and activation link while pending', () => {
    render(
      <ConnectionsPanel
        connections={{ twitch: { platform: 'twitch', state: 'pending', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' } }}
        {...handlers()}
      />,
    );
    expect(screen.getByText('ABCDEFGH')).toBeTruthy();
    const link = screen.getByRole('link', { name: /twitch\.tv\/activate/ });
    expect(link.getAttribute('href')).toBe('https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('connects and disconnects Twitch', () => {
    const h = handlers();
    const { rerender } = render(<ConnectionsPanel connections={{ twitch: { platform: 'twitch', state: 'disconnected' } }} {...h} />);
    fireEvent.click(within(screen.getByTestId('conn-twitch')).getByRole('button', { name: 'Connect' }));
    expect(h.onConnect).toHaveBeenCalledWith('twitch');
    rerender(<ConnectionsPanel connections={{ twitch: { platform: 'twitch', state: 'connected', account: 'yatf' } }} {...h} />);
    expect(screen.getByText('yatf')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('conn-twitch')).getByRole('button', { name: 'Disconnect' }));
    expect(h.onDisconnect).toHaveBeenCalledWith('twitch');
  });

  it('asks for the YouTube client, submits trimmed values and clears the secret field', () => {
    const h = handlers();
    render(<ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'disconnected', clientConfigured: false } }} {...h} />);
    const id = screen.getByLabelText('Client ID') as HTMLInputElement;
    const secret = screen.getByLabelText('Client secret') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(id, { target: { value: ' cid ' } });
    fireEvent.change(secret, { target: { value: ' s3 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }));
    expect(h.onSetYoutubeClient).toHaveBeenCalledWith('cid', 's3');
    expect(secret.value).toBe('');
  });

  it('links the Google sign-in only when it is https', () => {
    const { rerender } = render(
      <ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } }} {...handlers()} />,
    );
    expect(screen.getByRole('link', { name: 'Continue to Google sign-in' }).getAttribute('href')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    rerender(
      <ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: 'javascript:alert(1)' } }} {...handlers()} />,
    );
    expect(screen.queryByRole('link', { name: 'Continue to Google sign-in' })).toBeNull();
  });

  it('shows errors and the YouTube policy links', () => {
    render(<ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'error', detail: 'YouTube sign-in expired. Reconnect YouTube on the Connections page.' } }} {...handlers()} />);
    expect(screen.getByText(/sign-in expired/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'YouTube Terms of Service' }).getAttribute('href')).toBe('https://www.youtube.com/t/terms');
    expect(screen.getByRole('link', { name: 'Google Privacy Policy' }).getAttribute('href')).toBe('https://policies.google.com/privacy');
  });

  it('marks Kick as coming later', () => {
    render(<ConnectionsPanel connections={{ kick: { platform: 'kick', state: 'disconnected', detail: 'Kick arrives with the relay (M3).' } }} {...handlers()} />);
    expect(within(screen.getByTestId('conn-kick')).getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true);
  });

  it('lets a pending connection be started again', () => {
    const h = handlers();
    render(
      <ConnectionsPanel
        connections={{
          twitch: { platform: 'twitch', state: 'pending', userCode: 'ABCDEFGH' },
          youtube: { platform: 'youtube', state: 'pending', clientConfigured: true },
        }}
        {...h}
      />,
    );
    for (const platform of ['twitch', 'youtube'] as const) {
      const button = within(screen.getByTestId(`conn-${platform}`)).getByRole('button', { name: 'Start again' });
      expect(button).toHaveProperty('disabled', false);
      fireEvent.click(button);
      expect(h.onConnect).toHaveBeenCalledWith(platform);
    }
  });

  it('keeps the client secret out of browser password saving', () => {
    render(<ConnectionsPanel connections={{ youtube: { platform: 'youtube', state: 'disconnected', clientConfigured: false } }} {...handlers()} />);
    expect(screen.getByLabelText('Client secret').getAttribute('autocomplete')).toBe('new-password');
  });
});
