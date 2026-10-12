// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubClient, HubStatus } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { chatMessage } from '@streamhub/shared/testing';
import { loadWindowSize, nextWindowSize, setChatOnTop } from '../chatWindow';
import { ChatWindow } from './ChatWindow';

let seq = 0;
const ev = (type: string, payload: unknown): Envelope => ({ id: String(seq++).padStart(26, '0'), type, ts: 0, source: 'hub', payload });

function fakeHub() {
  const handlers = new Map<string, Set<(e: Envelope) => void>>();
  const statuses = new Set<(s: HubStatus) => void>();
  const publish = vi.fn();
  const client: HubClient = {
    on: (topic, h) => {
      const set = handlers.get(topic) ?? new Set();
      handlers.set(topic, set);
      set.add(h);
      return () => void set.delete(h);
    },
    publish,
    history: async () => [],
    onStatus: (h) => {
      statuses.add(h);
      return () => void statuses.delete(h);
    },
    onError: () => () => {},
    close: () => {},
  };
  const emit = (type: string, payload: unknown) =>
    act(() => {
      const e = ev(type, payload);
      for (const [topic, set] of handlers) {
        if (topic === e.type || (topic.endsWith('.') && e.type.startsWith(topic))) set.forEach((h) => h(e));
      }
    });
  const status = (s: HubStatus) => act(() => statuses.forEach((h) => h(s)));
  return { client, emit, status, publish };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('ChatWindow', () => {
  it('says when the hub is offline and shows ON AIR only while OBS is connected and live', () => {
    const hub = fakeHub();
    render(<ChatWindow client={hub.client} />);
    expect(screen.getByText('Hub offline')).toBeTruthy();
    hub.status('open');
    expect(screen.queryByText('Hub offline')).toBeNull();
    hub.emit('obs.stream.state', { state: 'live', startedAt: Date.now() });
    expect(screen.queryByText('ON AIR')).toBeNull();
    hub.emit('obs.connection', { connected: true });
    expect(screen.getByText('ON AIR')).toBeTruthy();
    hub.emit('obs.stream.state', { state: 'stopped' });
    expect(screen.queryByText('ON AIR')).toBeNull();
  });

  it('starts large and remembers the text size', () => {
    const hub = fakeHub();
    render(<ChatWindow client={hub.client} />);
    expect(screen.getByRole('region', { name: 'Chat' }).className).toContain('size-large');
    fireEvent.click(screen.getByRole('button', { name: /Text size/ }));
    expect(screen.getByRole('region', { name: 'Chat' }).className).toContain('size-xlarge');
    expect(loadWindowSize()).toBe('xlarge');
    cleanup();
    render(<ChatWindow client={hub.client} />);
    expect(screen.getByRole('region', { name: 'Chat' }).className).toContain('size-xlarge');
  });

  it('takes the featured message down from the bar at the top', () => {
    const hub = fakeHub();
    render(<ChatWindow client={hub.client} />);
    hub.status('open');
    const m = chatMessage({ id: 'twitch:9', text: 'quota question', fragments: [{ kind: 'text', text: 'quota question' }], author: { id: 'm', name: 'Marc', roles: [] } });
    hub.emit('chat.cleared', { platform: 'kick' });
    hub.emit('show.feature.set', { message: m });
    expect(screen.getByText('On screen now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take down' }));
    expect(hub.publish).toHaveBeenCalledWith('show.feature.clear');
  });

  it('shows viewers per platform in the footer', () => {
    const hub = fakeHub();
    render(<ChatWindow client={hub.client} />);
    hub.status('open');
    hub.emit('platform.live', { platform: 'twitch', broadcast: 'running', viewers: 128 });
    hub.emit('platform.live', { platform: 'youtube', broadcast: 'none' });
    expect(screen.getByText('Twitch 128')).toBeTruthy();
    expect(screen.queryByText(/YouTube \d/)).toBeNull();
  });

  it('offers Keep on top only in the desktop app', async () => {
    const hub = fakeHub();
    render(<ChatWindow client={hub.client} />);
    expect(screen.queryByRole('button', { name: 'Keep on top' })).toBeNull();
    cleanup();
    const invoke = vi.fn(async () => undefined);
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    render(<ChatWindow client={hub.client} />);
    const pin = screen.getByRole('button', { name: 'Keep on top' });
    await act(async () => fireEvent.click(pin));
    expect(invoke).toHaveBeenCalledWith('plugin:window|set_always_on_top', { label: 'chat', value: true });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('chat window helpers', () => {
  it('cycles sizes and ignores a broken saved value', () => {
    expect(nextWindowSize('large')).toBe('xlarge');
    expect(nextWindowSize('xlarge')).toBe('medium');
    expect(nextWindowSize('medium')).toBe('large');
    localStorage.setItem('streamhub.chatWindow.size', 'huge');
    expect(loadWindowSize()).toBe('large');
  });

  it('does nothing outside the desktop app', async () => {
    await expect(setChatOnTop(true)).resolves.toBeUndefined();
  });
});
