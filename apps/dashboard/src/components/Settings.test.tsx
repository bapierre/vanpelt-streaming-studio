// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreferencesPage } from './settings/PreferencesPage';
import { SecretInput, SecretText } from './Secret';
import { SourcesPanel } from './SourcesPanel';
import { RANGE_SEND_MS } from './ThrottledRange';

afterEach(cleanup);

describe('secrets', () => {
  it('masks an input until Reveal is clicked', () => {
    render(<SecretInput label="Stream key" defaultValue="live_123" />);
    const input = screen.getByLabelText('Stream key') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Stream key' }));
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Stream key' }));
    expect(input.type).toBe('password');
  });
  it('blurs a code until Reveal is clicked', () => {
    render(<SecretText value="ABCDEFGH" label="Twitch code" />);
    expect(screen.getByText('ABCDEFGH').className).toContain('blurred');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Twitch code' }));
    expect(screen.getByText('ABCDEFGH').className).not.toContain('blurred');
  });
});

describe('SourcesPanel', () => {
  it('toggles a source in the current scene', () => {
    const onToggle = vi.fn();
    render(
      <SourcesPanel
        sources={{ scene: 'Main', sources: [{ name: 'Webcam', visible: true }] }}
        disabled={false}
        onToggle={onToggle}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Show Webcam' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith('Main', 'Webcam', false);
  });
});

describe('PreferencesPage', () => {
  it('sets the sound check target and the dashboard preferences', () => {
    vi.useFakeTimers();
    const onTarget = vi.fn();
    const onPrefs = vi.fn();
    render(
      <PreferencesPage targetDb={-20} disabled={false} prefs={{ startTab: 'last', chatSize: 'medium' }} onTarget={onTarget} onPrefs={onPrefs} />,
    );
    fireEvent.change(screen.getByLabelText('Sound check target'), { target: { value: '-18' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    fireEvent.change(screen.getByLabelText('Open on'), { target: { value: 'onscreen' } });
    fireEvent.change(screen.getByLabelText('Chat text size'), { target: { value: 'large' } });
    expect(onTarget).toHaveBeenCalledWith(-18);
    expect(onPrefs.mock.calls).toEqual([[{ startTab: 'onscreen' }], [{ chatSize: 'large' }]]);
    const options = [...(screen.getByLabelText('Open on') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).not.toContain('settings');
    vi.useRealTimers();
  });

  it('locks the target until the hub has sent it', () => {
    render(
      <PreferencesPage targetDb={null} disabled={false} prefs={{ startTab: 'last', chatSize: 'medium' }} onTarget={vi.fn()} onPrefs={vi.fn()} />,
    );
    expect((screen.getByLabelText('Sound check target') as HTMLInputElement).disabled).toBe(true);
  });
});
