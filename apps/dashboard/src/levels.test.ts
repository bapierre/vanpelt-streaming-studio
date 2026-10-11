import { describe, expect, it, vi } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import type { Levels } from './audio';
import { createLevelsStore } from './levels';

/** A hub that only speaks when the test emits. */
function fakeClient() {
  let handler: ((e: Envelope) => void) | undefined;
  const client: HubClient = {
    on: (_topic, h) => {
      handler = h;
      return () => {};
    },
    publish: () => {},
    history: async () => [],
    onStatus: () => () => {},
    onError: () => () => {},
    close: () => {},
  };
  const emit = (levels: Levels) => handler?.({ id: '1', type: 'audio.levels', ts: 0, source: 'hub', payload: { levels } });
  return { client, emit };
}

describe('createLevelsStore', () => {
  it('keeps the latest level per mic', () => {
    const { client, emit } = fakeClient();
    const store = createLevelsStore(client);
    expect(store.get('host')).toBeUndefined();
    emit({ host: { rmsDb: -20, peakDb: -4 } });
    expect(store.get('host')).toEqual({ rmsDb: -20, peakDb: -4 });
    emit({ host: { rmsDb: -9, peakDb: -3 } });
    expect(store.get('host')).toEqual({ rmsDb: -9, peakDb: -3 });
  });

  it('only notifies when that mic’s values actually changed', () => {
    const { client, emit } = fakeClient();
    const store = createLevelsStore(client);
    const host = vi.fn();
    const guest = vi.fn();
    store.subscribe('host', host);
    store.subscribe('guest', guest);
    emit({ host: { rmsDb: -20, peakDb: -4 }, guest: { rmsDb: -100, peakDb: -100 } });
    expect(host).toHaveBeenCalledTimes(1);
    expect(guest).toHaveBeenCalledTimes(1);
    // A silent mic reports the same values 15×/s; that must not re-render it.
    emit({ host: { rmsDb: -20, peakDb: -4 }, guest: { rmsDb: -100, peakDb: -100 } });
    expect(host).toHaveBeenCalledTimes(1);
    expect(guest).toHaveBeenCalledTimes(1);
    emit({ host: { rmsDb: -21, peakDb: -4 }, guest: { rmsDb: -100, peakDb: -100 } });
    expect(host).toHaveBeenCalledTimes(2);
    expect(guest).toHaveBeenCalledTimes(1);
  });

  it('clears mics that vanish from the levels event', () => {
    const { client, emit } = fakeClient();
    const store = createLevelsStore(client);
    const host = vi.fn();
    store.subscribe('host', host);
    emit({ host: { rmsDb: -20, peakDb: -4 } });
    emit({});
    expect(store.get('host')).toBeUndefined();
    expect(host).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const { client, emit } = fakeClient();
    const store = createLevelsStore(client);
    const host = vi.fn();
    const off = store.subscribe('host', host);
    emit({ host: { rmsDb: -20, peakDb: -4 } });
    off();
    emit({ host: { rmsDb: -10, peakDb: -2 } });
    expect(host).toHaveBeenCalledTimes(1);
    expect(store.get('host')).toEqual({ rmsDb: -10, peakDb: -2 });
  });
});
