// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventPayload } from '@streamhub/shared';
import type { Prefs } from '../prefs';
import { initialState, type DashboardState } from '../state';
import { SettingsArea } from './Settings';
import type { Studio } from '../useStudio';

afterEach(cleanup);

const prefs: Prefs = { startTab: 'last', chatSize: 'medium', appearance: 'system' };/** Just enough of a Studio for SettingsArea, with a publishing spy for every command. */
function studio(over: Partial<DashboardState> = {}, mics = 0) {
  const publish = vi.fn();
  const state: DashboardState = {
    ...initialState,
    hubConnected: true,
    obs: { connected: true },
    ...over,
  };
  const s = {
    client: { publish },
    state,
    audio: { state: { mics: Array.from({ length: mics }, () => ({})), targetDb: -20, recordTracks: [1], tracksPending: false } },
    alerts: { modules: null },
    cameras: [],
    takeCamera: vi.fn(),
    audioActions: { onTarget: vi.fn() },
    obsReady: state.hubConnected && state.obs.connected,
  } as unknown as Studio;
  return { studio: s, publish, state };
}

describe('SettingsArea sidebar', () => {
  it('groups the pages and opens on Setup overview', () => {
    const { studio: s } = studio();
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings pages' }));
    for (const group of ['Get started', 'Connections', 'Studio', 'App']) expect(nav.getByRole('heading', { name: group })).toBeTruthy();
    expect(nav.getByRole('button', { name: /Setup overview/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('region', { name: 'Setup overview' })).toBeTruthy();
  });

  it('shows the progress as the sidebar note, and one page at a time', () => {
    const { studio: s } = studio({}, 2);
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings pages' }));
    expect(nav.getByText('2 of 4')).toBeTruthy();
    fireEvent.click(nav.getByRole('button', { name: 'Preferences' }));
    expect(screen.getByRole('region', { name: 'Preferences' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Setup overview' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Preferences' })).getByLabelText('Sound check target')).toBeTruthy();
  });

  it('opens on the page a fix asked for, and maps the old flat ids somewhere useful', () => {
    const { studio: s } = studio();
    const { rerender } = render(<SettingsArea studio={s} initial="obs" prefs={prefs} onPrefs={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'OBS' })).toBeTruthy();
    rerender(<SettingsArea key="g" studio={s} initial="general" prefs={prefs} onPrefs={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Preferences' })).toBeTruthy();
  });

  it('dots OBS and unconfigured platforms, not plain disconnects', () => {
    const { studio: s } = studio({
      obs: { connected: false },
      connections: {
        twitch: { platform: 'twitch', state: 'disconnected', clientConfigured: false },
        youtube: { platform: 'youtube', state: 'disconnected', clientConfigured: true },
      },
    });
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings pages' }));
    expect(nav.getByRole('button', { name: /OBS/ }).querySelector('.attention')).toBeTruthy();
    expect(nav.getByRole('button', { name: /Twitch/ }).querySelector('.attention')).toBeTruthy();
    expect(nav.getByRole('button', { name: /YouTube/ }).querySelector('.attention')).toBeNull();
  });
});

describe('Setup overview', () => {
  it('marks done steps from real state and highlights the next undone one with its button', () => {
    const { studio: s } = studio({ connections: { twitch: { platform: 'twitch', state: 'connected', account: 'yatf' } } }, 2);
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    const steps = within(screen.getByRole('region', { name: 'Setup overview' }));
    expect(steps.getByText('OBS is connected.')).toBeTruthy();
    expect(steps.getByText('2 mics set up.')).toBeTruthy();
    expect(steps.getByText('Twitch is connected.')).toBeTruthy();
    expect(steps.getByText('3 of 4 done')).toBeTruthy();
    expect(steps.getByRole('button', { name: 'Show me' })).toBeTruthy();
    expect(steps.queryByRole('button', { name: 'Connect Twitch' })).toBeNull();
    fireEvent.click(steps.getByRole('button', { name: 'Show me' }));
    expect(steps.getByText(/Waiting for the hub/)).toBeTruthy();
  });

  it('sends the next undone step to its page: Connect Twitch opens the Twitch page', () => {
    const { studio: s } = studio({ obs: { connected: false } });
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open OBS settings' }));
    expect(screen.getByRole('region', { name: 'OBS' })).toBeTruthy();
  });
});

describe('platform pages', () => {
  it('combines the connection and the stream key, and issues their commands', () => {
    const { studio: s, publish } = studio({
      connections: { twitch: { platform: 'twitch', state: 'disconnected', clientConfigured: true } },
      destinations: {
        destinations: [{ id: 'twitch', label: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'k' }],
        inObs: 'twitch',
      },
    });
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings pages' })).getByRole('button', { name: /Twitch/ }));
    const page = within(screen.getByRole('region', { name: 'Twitch' }));
    expect(page.getByRole('region', { name: 'Twitch: Chat and alerts' })).toBeTruthy();
    expect(page.getByText('OBS streams to Twitch as its main output')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: 'Connect' }));
    expect(publish).toHaveBeenCalledWith('connections.cmd.connect', { platform: 'twitch' });
    expect((page.getByRole('button', { name: 'Use in OBS' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for the Twitch client id when none is saved, then saves and connects', async () => {
    const { studio: s, publish } = studio({ connections: { twitch: { platform: 'twitch', state: 'disconnected', clientConfigured: false } } });
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings pages' })).getByRole('button', { name: /Twitch/ }));
    const page = within(screen.getByRole('region', { name: 'Twitch' }));
    expect(page.getByText('Not set up')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Connect' })).toBeNull();
    fireEvent.change(page.getByLabelText('Client ID'), { target: { value: ' cid ' } });
    fireEvent.click(page.getByRole('button', { name: 'Save and connect' }));
    expect(publish).toHaveBeenCalledWith('connections.cmd.setTwitchClient', { clientId: 'cid' });
  });

  it('keeps Kick honest: coming later, no connect button, stream key still works', () => {
    const { studio: s } = studio({ connections: { kick: { platform: 'kick', state: 'disconnected', detail: 'Kick arrives with the relay (M3).' } } });
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings pages' })).getByRole('button', { name: /Kick/ }));
    const page = within(screen.getByRole('region', { name: 'Kick' }));
    expect(page.getByText('Coming later')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(page.getByRole('region', { name: 'Kick: Stream key' })).toBeTruthy();
  });

  it('explains that mics live in the Sound tab', () => {
    const { studio: s } = studio();
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings pages' })).getByRole('button', { name: 'Mics and headsets' }));
    expect(screen.getByText('Mics and headphones are set up in the Sound tab (⌘2).')).toBeTruthy();
  });

  it('puts custom destinations on the Other destinations page, not on a platform page', () => {
    const restream = { id: 'restream', label: 'Restream', server: 'rtmp://live.restream.io/app', key: 'r1' };
    const { studio: s, publish } = studio({ destinations: { destinations: [restream], inObs: null } });
    render(<SettingsArea studio={s} prefs={prefs} onPrefs={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings pages' })).getByRole('button', { name: 'Other destinations' }));
    const page = within(screen.getByRole('region', { name: 'Other destinations' }));
    expect(page.getByRole('region', { name: 'Restream: Stream key' })).toBeTruthy();
    fireEvent.change(page.getByLabelText('Label'), { target: { value: 'Vaughn live' } });
    fireEvent.change(page.getByLabelText('Server URL'), { target: { value: 'rtmp://v.example/live' } });
    fireEvent.change(page.getByLabelText('Stream key'), { target: { value: 'k' } });
    fireEvent.click(page.getByRole('button', { name: 'Add' }));
    expect(publish).toHaveBeenCalledWith('destinations.cmd.save', {
      id: 'vaughn-live',
      label: 'Vaughn live',
      server: 'rtmp://v.example/live',
      key: 'k',
    });
  });
});

describe('OBS page', () => {
  it('saves the server, reconnects and refreshes scenes and sources', () => {
    const { studio: s, publish } = studio({ obsSettings: { url: 'ws://127.0.0.1:4455', passwordSet: true } });
    render(<SettingsArea studio={s} initial="obs" prefs={prefs} onPrefs={vi.fn()} />);
    const page = within(screen.getByRole('region', { name: 'OBS' }));
    fireEvent.change(page.getByLabelText('Server address'), { target: { value: 'ws://127.0.0.1:4456' } });
    fireEvent.change(page.getByLabelText('Server password'), { target: { value: 'pw' } });
    fireEvent.click(page.getByRole('button', { name: 'Save and connect' }));
    const setObs = publish.mock.calls.find(([type]) => type === 'connections.cmd.setObs') as unknown as [string, EventPayload<'connections.cmd.setObs'>];
    expect(setObs[1]).toEqual({ url: 'ws://127.0.0.1:4456', password: 'pw' });
    fireEvent.click(page.getByRole('button', { name: 'Refresh scenes and sources' }));
    expect(publish).toHaveBeenCalledWith('obs.cmd.refresh');
    fireEvent.click(page.getByRole('button', { name: 'Reconnect' }));
    expect(publish).toHaveBeenCalledWith('obs.cmd.reconnect');
  });
});
