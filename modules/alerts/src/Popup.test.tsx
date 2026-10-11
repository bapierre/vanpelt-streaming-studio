// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertShow, Envelope } from '@streamhub/shared';
import { LEAVE_MS, Popup } from './Popup';

type Handler = (e: Envelope) => void;

function fakeHub() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(topic: string, h: Handler) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)!.delete(h);
    },
    emit(type: string, payload: unknown) {
      const e = { v: 1, id: 'x', type, ts: 0, source: 'hub:alerts', payload } as Envelope;
      act(() => handlers.get(type)?.forEach((h) => h(e)));
    },
    count: (topic: string) => handlers.get(topic)?.size ?? 0,
  };
}

const show = (id: string, over: Partial<AlertShow['alert']> = {}): AlertShow => ({
  alert: {
    id,
    kind: 'follow',
    platform: 'twitch',
    user: { id: 'u1', name: 'ada' },
    at: 0,
    ...over,
  },
  text: `${over.user?.name ?? 'ada'} just followed!`,
  sound: 'pop',
  volume: 0.5,
  durationMs: 5000,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Popup', () => {
  it('shows an alert with its text, label and sound, then leaves on alert.hide', () => {
    const hub = fakeHub();
    const playSound = vi.fn();
    render(<Popup hub={hub} playSound={playSound} />);
    expect(screen.queryByRole('status')).toBeNull();

    hub.emit('alert.show', show('twitch:follow:1'));
    const card = screen.getByRole('status');
    expect(card.textContent).toContain('New follower');
    expect(card.textContent).toContain('ada just followed!');
    expect(card.className).toContain('kind-follow');
    expect(screen.getByText('A')).toBeTruthy();
    expect(playSound).toHaveBeenCalledWith('pop', 0.5);

    hub.emit('alert.hide', { id: 'twitch:follow:1' });
    expect(screen.getByRole('status').className).toContain('leaving');
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores a hide for another alert', () => {
    const hub = fakeHub();
    render(<Popup hub={hub} playSound={() => {}} />);
    hub.emit('alert.show', show('a'));
    hub.emit('alert.hide', { id: 'old' });
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(screen.getByRole('status').className).not.toContain('leaving');
  });

  it('replaces a leaving alert when the next one arrives', () => {
    const hub = fakeHub();
    render(<Popup hub={hub} playSound={() => {}} />);
    hub.emit('alert.show', show('a'));
    hub.emit('alert.hide', { id: 'a' });
    hub.emit('alert.show', show('b', { kind: 'tip', user: { id: 'u2', name: 'bo' } }));
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    const card = screen.getByRole('status');
    expect(card.className).toContain('kind-tip');
    expect(card.className).not.toContain('leaving');
  });

  it('hides by itself when alert.hide never comes', () => {
    const hub = fakeHub();
    render(<Popup hub={hub} playSound={() => {}} />);
    hub.emit('alert.show', show('a'));
    act(() => vi.advanceTimersByTime(5000 + 2000 + LEAVE_MS));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the avatar, the viewer message, and unsubscribes on unmount', () => {
    const hub = fakeHub();
    const { container, unmount } = render(<Popup hub={hub} playSound={() => {}} />);
    hub.emit(
      'alert.show',
      show('a', {
        kind: 'cheer',
        user: { id: 'u', name: 'cy', avatarUrl: 'https://example.com/a.png' },
        message: 'great show',
      }),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(screen.getByText('great show')).toBeTruthy();
    unmount();
    expect(hub.count('alert.show')).toBe(0);
    expect(hub.count('alert.hide')).toBe(0);
  });
});
