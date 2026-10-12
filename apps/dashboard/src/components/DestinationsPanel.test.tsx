// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DestinationsPanel, isCustomDestination, StreamKeyCard, type StreamKeyActions } from './DestinationsPanel';

afterEach(cleanup);

const twitch = { id: 'twitch', label: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'live_1' };
const actions = (): StreamKeyActions => ({ onSave: vi.fn(), onRemove: vi.fn(), onUseInObs: vi.fn() });

describe('StreamKeyCard', () => {
  it('shows a saved key masked, with copy, use in OBS, edit and remove', () => {
    const h = actions();
    render(<StreamKeyCard platform="twitch" destination={twitch} inObs={false} canUseInObs actions={h} />);
    const card = within(screen.getByRole('region', { name: 'Twitch: Stream key' }));
    expect(card.getByText('rtmp://live.twitch.tv/app')).toBeTruthy();
    expect(card.getByText('live_1').className).toContain('blurred');
    fireEvent.click(card.getByRole('button', { name: 'Copy Twitch stream key' }));
    fireEvent.click(card.getByRole('button', { name: 'Use in OBS' }));
    expect(h.onUseInObs).toHaveBeenCalledWith('twitch');
    fireEvent.click(card.getByRole('button', { name: 'Remove' }));
    expect(h.onRemove).toHaveBeenCalledWith('twitch');
  });

  it('says when OBS streams to this destination', () => {
    render(<StreamKeyCard platform="twitch" destination={twitch} inObs canUseInObs={false} actions={actions()} />);
    expect(screen.getAllByText('In OBS').length).toBeGreaterThan(0);
    expect(screen.getByText('OBS streams to Twitch as its main output')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Use in OBS' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers an empty form when nothing is saved, and refuses non-RTMP servers', () => {
    const h = actions();
    render(<StreamKeyCard platform="youtube" destination={undefined} inObs={false} canUseInObs actions={h} />);
    const form = within(screen.getByRole('region', { name: 'YouTube: Stream key' }));
    const save = form.getByRole('button', { name: 'Save' });
    fireEvent.change(form.getByLabelText('Server URL'), { target: { value: 'https://youtube.com' } });
    fireEvent.change(form.getByLabelText('Stream key'), { target: { value: 'k' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(form.getByLabelText('Server URL'), { target: { value: ' rtmp://a.example/live2 ' } });
    fireEvent.click(save);
    expect(h.onSave).toHaveBeenCalledWith({ id: 'youtube', label: 'YouTube', server: 'rtmp://a.example/live2', key: 'k' });
  });

  it('edits a saved destination and keeps the form in sync with saved state', () => {
    const h = actions();
    const { rerender } = render(<StreamKeyCard platform="twitch" destination={twitch} inObs={false} canUseInObs actions={h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const server = screen.getByLabelText('Server URL') as HTMLInputElement;
    expect(server.value).toBe(twitch.server);
    fireEvent.change(screen.getByLabelText('Stream key'), { target: { value: 'live_2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(h.onSave).toHaveBeenCalledWith({ ...twitch, key: 'live_2' });
    rerender(<StreamKeyCard platform="twitch" destination={{ ...twitch, key: 'live_2' }} inObs={false} canUseInObs actions={h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Stream key') as HTMLInputElement).value).toBe('live_2');
  });
});

describe('isCustomDestination', () => {
  it('separates platform destinations from custom ones', () => {
    expect(isCustomDestination(twitch)).toBe(false);
    expect(isCustomDestination({ id: 'restream', label: 'Restream', server: 'rtmp://x', key: 'k' })).toBe(true);
  });
});

describe('DestinationsPanel (Other destinations page)', () => {
  const restream = { id: 'restream', label: 'Restream', server: 'rtmp://live.restream.io/app', key: 'r1' };

  it('lists only custom destinations, and marks the one OBS uses', () => {
    const h = actions();
    render(
      <DestinationsPanel destinations={[twitch, restream]} inObs="restream" obsReady live={false} actions={h} />,
    );
    expect(screen.queryByRole('region', { name: 'Twitch: Stream key' })).toBeNull();
    const card = within(screen.getByRole('region', { name: 'Restream: Stream key' }));
    expect(card.getByText('OBS streams to Restream as its main output')).toBeTruthy();
  });

  it('adds a custom destination with a slug id, deduped against every saved id', () => {
    const h = actions();
    render(
      <DestinationsPanel destinations={[twitch, { ...restream, id: 'my-server', label: 'My server' }]} inObs={null} obsReady live={false} actions={h} />,
    );
    const form = within(screen.getByRole('region', { name: 'Add a destination' }));
    fireEvent.change(form.getByLabelText('Label'), { target: { value: 'My Server!' } });
    fireEvent.change(form.getByLabelText('Server URL'), { target: { value: 'rtmp://x.example/live' } });
    fireEvent.change(form.getByLabelText('Stream key'), { target: { value: 'k' } });
    fireEvent.click(form.getByRole('button', { name: 'Add' }));
    expect(h.onSave).toHaveBeenCalledWith({ id: 'my-server-2', label: 'My Server!', server: 'rtmp://x.example/live', key: 'k' });
  });

  it('keeps Use in OBS off while live', () => {
    render(<DestinationsPanel destinations={[restream]} inObs={null} obsReady={false} live actions={actions()} />);
    expect((screen.getByRole('button', { name: 'Use in OBS' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
