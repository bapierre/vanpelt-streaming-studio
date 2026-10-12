import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { ScenePreview } from '@streamhub/shared';

/** The dashboard refreshes the lease this often; the hub stops capturing ~12 s after the last one. */
export const PREVIEW_LEASE_MS = 5_000;

/**
 * Latest thumbnail per scene, outside React state: the program image updates about once a second,
 * and only the tile whose picture changed should re-render (same reason as the levels store).
 */
export type PreviewsStore = {
  get(scene: string): string | undefined;
  subscribe(scene: string, listener: () => void): () => void;
  clear(): void;
};

/** One store per client: it owns the `obs.scene.preview` subscription for the whole dashboard. */
export function createPreviewsStore(client: HubClient): PreviewsStore {
  const images: Record<string, string> = {};
  const listeners = new Map<string, Set<() => void>>();
  const notify = (scene: string) => listeners.get(scene)?.forEach((l) => l());
  const clear = () => {
    for (const scene of Object.keys(images)) delete images[scene];
    for (const set of listeners.values()) set.forEach((l) => l());
  };
  client.on('obs.scene.preview', (e) => {
    const { scene, image } = e.payload as ScenePreview;
    if (images[scene] === image) return;
    images[scene] = image;
    notify(scene);
  });
  // A dropped hub connection means OBS may have moved on; no stale picture survives a reconnect.
  client.onStatus((s) => s !== 'open' && clear());
  return {
    get: (scene) => images[scene],
    subscribe(scene, listener) {
      const set = listeners.get(scene) ?? new Set();
      listeners.set(scene, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(scene);
      };
    },
    clear,
  };
}

/** The newest thumbnail of one scene, re-rendering only when that scene's image changes. */
export function useSceneImage(store: PreviewsStore, scene: string): string | undefined {
  const subscribe = useCallback((notify: () => void) => store.subscribe(scene, notify), [store, scene]);
  return useSyncExternalStore(subscribe, () => store.get(scene));
}

/** True while the document is visible; thumbnails for a hidden tab would be wasted GPU work. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/**
 * Holds the hub's preview lease while `active` (mounted, visible, switched on). The hub captures
 * thumbnails only while at least one dashboard keeps the lease fresh, so OBS does no thumbnail
 * work for a dashboard nobody is looking at.
 */
export function usePreviewLease(client: HubClient, active: boolean) {
  useEffect(() => {
    if (!active) return;
    client.publish('obs.cmd.previews.watch');
    const timer = setInterval(() => client.publish('obs.cmd.previews.watch'), PREVIEW_LEASE_MS);
    return () => clearInterval(timer);
  }, [client, active]);
}
