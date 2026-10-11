// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DestinationsPanel } from './DestinationsPanel';
import { SecretInput, SecretText } from './Secret';
import { SettingsSheet } from './SettingsSheet';
import { SourcesPanel } from './SourcesPanel';

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

describe('DestinationsPanel', () => {
  const twitch = { id: 'twitch', label: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'live_1' };
  const panel = (props: Partial<Parameters<typeof DestinationsPanel>[0]> = {}) => {
    const handlers = { onSave: vi.fn(), onRemove: vi.fn(), onUseInObs: vi.fn() };
    render(
      <DestinationsPanel list={{ destinations: [twitch], inObs: null }} obsReady live={false} {...handlers} {...props} />,
    );
    return handlers;
  };

  it('saves a trimmed RTMP destination and refuses other URLs', () => {
    const { onSave } = panel();
    const row = within(screen.getByTestId('dest-youtube'));
    const save = row.getByRole('button', { name: 'Save' });
    fireEvent.change(row.getByLabelText('Server URL'), { target: { value: 'https://youtube.com' } });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(row.getByLabelText('Server URL'), { target: { value: ' rtmp://a.example/live2 ' } });
    fireEvent.change(row.getByLabelText('Stream key'), { target: { value: ' abc ' } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ id: 'youtube', label: 'YouTube', server: 'rtmp://a.example/live2', key: 'abc' });
  });

  it('only offers Use in OBS for saved destinations while not live', () => {
    const { onUseInObs } = panel();
    expect(within(screen.getByTestId('dest-youtube')).queryByRole('button', { name: 'Use in OBS' })).toBeNull();
    fireEvent.click(within(screen.getByTestId('dest-twitch')).getByRole('button', { name: 'Use in OBS' }));
    expect(onUseInObs).toHaveBeenCalledWith('twitch');
    cleanup();
    panel({ live: true });
    expect(within(screen.getByTestId('dest-twitch')).getByRole('button', { name: 'Use in OBS' })).toHaveProperty('disabled', true);
  });
});

describe('SettingsSheet', () => {
  it('switches tabs and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <SettingsSheet
        onClose={onClose}
        tabs={[
          { id: 'a', label: 'OBS', content: <p>obs body</p> },
          { id: 'b', label: 'Platforms', content: <p>platforms body</p> },
        ]}
      />,
    );
    expect(screen.getByText('obs body')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Platforms' }));
    expect(screen.getByText('platforms body')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
