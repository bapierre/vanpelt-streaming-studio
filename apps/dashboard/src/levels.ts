import type { HubClient } from '@streamhub/overlay-sdk';
import type { AudioLevels } from '@streamhub/shared';
import type { Levels } from './audio';

export type Level = Levels[string];

/**
 * Meter levels outside React state: `audio.levels` ticks up to 15 times per second,
 * and only the meters of mics whose values actually changed should re-render.
 */
export type LevelsStore = {
  get(id: string): Level | undefined;
  /** Calls `listener` only when this mic's levels changed (or the mic vanished). */
  subscribe(id: string, listener: () => void): () => void;
};

/** One store per client: it owns the `audio.levels` subscription for the whole dashboard. */
export function createLevelsStore(client: HubClient): LevelsStore {
  const levels: Levels = {};
  const listeners = new Map<string, Set<() => void>>();
  client.on('audio.levels', (e) => {
    const next = (e.payload as AudioLevels).levels;
    const changed: string[] = [];
    for (const [id, l] of Object.entries(next)) {
      const prev = levels[id];
      if (!prev || prev.peakDb !== l.peakDb || prev.rmsDb !== l.rmsDb) {
        levels[id] = l;
        changed.push(id);
      }
    }
    for (const id of Object.keys(levels)) {
      if (!(id in next)) {
        delete levels[id];
        changed.push(id);
      }
    }
    for (const id of changed) listeners.get(id)?.forEach((notify) => notify());
  });
  return {
    get: (id) => levels[id],
    subscribe(id, listener) {
      const set = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}
