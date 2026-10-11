// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { chatMessage } from '@streamhub/shared/testing';
import { useDashboardState } from './useDashboardState';

let seq = 0;
const ev = (type: string, payload: unknown): Envelope => ({
  id: String(seq++).padStart(26, '0'),
  type,
  ts: 0,
  source: 'hub',
  payload,
});

/** A hub that only speaks when the test emits, with prefix-topic routing like the real client. */
function fakeHub() {
  const handlers = new Map<string, Set<(e: Envelope) => void>>();
  const client: HubClient = {
    on: (topic, h) => {
      const set = handlers.get(topic) ?? new Set();
      handlers.set(topic, set);
      set.add(h);
      return () => {
        set.delete(h);
      };
    },
    publish: () => {},
    history: async () => [],
    onStatus: () => () => {},
    onError: () => () => {},
    close: () => {},
  };
  const emit = (e: Envelope) => {
    for (const [topic, set] of handlers) {
      if (topic === e.type || (topic.endsWith('.') && e.type.startsWith(topic))) set.forEach((h) => h(e));
    }
  };
  return { client, emit };
}

describe('useDashboardState chat batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Drive the per-frame flush from fake timers, whatever the environment provides.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('flushes a burst of chat messages in one render per frame', () => {
    const { client, emit } = fakeHub();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useDashboardState(client);
    });
    const before = renders;
    act(() => {
      emit(ev('chat.message', chatMessage({ id: 'twitch:1' })));
      emit(ev('chat.message', chatMessage({ id: 'twitch:2' })));
      emit(ev('chat.message', chatMessage({ id: 'twitch:3' })));
    });
    // Still queued: nothing re-rendered for the burst yet.
    expect(result.current.chat).toHaveLength(0);
    expect(renders).toBe(before);
    act(() => vi.advanceTimersByTime(16));
    expect(result.current.chat.map((m) => m.id)).toEqual(['twitch:1', 'twitch:2', 'twitch:3']);
    expect(renders).toBe(before + 1);
  });

  it('keeps the wire order when a delete overtakes the queued messages', () => {
    const { client, emit } = fakeHub();
    const { result } = renderHook(() => useDashboardState(client));
    act(() => {
      emit(ev('chat.message', chatMessage({ id: 'twitch:1' })));
      emit(ev('chat.deleted', { id: 'twitch:1' }));
      emit(ev('chat.message', chatMessage({ id: 'twitch:2' })));
    });
    act(() => vi.advanceTimersByTime(16));
    expect(result.current.chat.map((m) => m.id)).toEqual(['twitch:2']);
  });

  it('passes non-chat events straight through', () => {
    const { client, emit } = fakeHub();
    const { result } = renderHook(() => useDashboardState(client));
    act(() => emit(ev('obs.connection', { connected: true })));
    expect(result.current.obs.connected).toBe(true);
  });
});
