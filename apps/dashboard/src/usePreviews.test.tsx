// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import {
  createPreviewsStore,
  PREVIEW_LEASE_MS,
  usePreviewLease,
  useSceneImage,
  type PreviewsStore,
} from './usePreviews';

let hub: {
  client: HubClient;
  emit: (type: string, payload: unknown) => void;
  published: string[];
  fireStatus: (s: string) => void;
};

beforeEach(() => {
  const handlers: Array<{ topic: string; h: (e: Envelope) => void }> = [];
  const statusHandlers: Array<(s: string) => void> = [];
  const published: string[] = [];
  const client: HubClient = {
    on: (topic, h) => (handlers.push({ topic, h }), () => {}),
    onStatus: (h) => (statusHandlers.push(h as (s: string) => void), () => {}),
    onError: () => () => {},
    history: async () => [],
    publish: (type) => published.push(type),
    close: () => {},
  };
  hub = {
    client,
    published,
    fireStatus: (s) =>
      act(() => {
        statusHandlers.forEach((h) => h(s));
      }),
    emit: (type, payload) =>
      act(() => {
        handlers
          .filter((x) => type.startsWith(x.topic))
          .forEach((x) => x.h({ id: '1', ts: 0, source: 'hub', type, payload } as Envelope));
      }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function Tile({ store, scene }: { store: PreviewsStore; scene: string }) {
  const image = useSceneImage(store, scene);
  return <div data-testid={scene}>{image ?? 'none'}</div>;
}

describe('previews store', () => {
  it('keeps the newest image per scene', () => {
    const store = createPreviewsStore(hub.client);
    const { getByTestId } = render(
      <>
        <Tile store={store} scene="Showtime" />
        <Tile store={store} scene="Close-up" />
      </>,
    );
    expect(getByTestId('Showtime').textContent).toBe('none');
    hub.emit('obs.scene.preview', { scene: 'Showtime', image: 'data:image/jpeg;base64,QUJD', capturedAt: 1 });
    expect(getByTestId('Showtime').textContent).toBe('data:image/jpeg;base64,QUJD');
    hub.emit('obs.scene.preview', { scene: 'Showtime', image: 'data:image/jpeg;base64,V1la', capturedAt: 2 });
    hub.emit('obs.scene.preview', { scene: 'Close-up', image: 'data:image/png;base64,QUJD', capturedAt: 3 });
    expect(getByTestId('Showtime').textContent).toBe('data:image/jpeg;base64,V1la');
    expect(getByTestId('Close-up').textContent).toBe('data:image/png;base64,QUJD');
  });

  it('clears every image when the hub connection drops, so no stale picture survives a reconnect', () => {
    const store = createPreviewsStore(hub.client);
    const { getByTestId } = render(<Tile store={store} scene="Showtime" />);
    hub.emit('obs.scene.preview', { scene: 'Showtime', image: 'data:image/jpeg;base64,QUJD', capturedAt: 1 });
    hub.fireStatus('closed');
    expect(getByTestId('Showtime').textContent).toBe('none');
  });
});

describe('preview lease', () => {
  const Lease = ({ enabled }: { enabled: boolean }) => {
    usePreviewLease(hub.client, enabled);
    return null;
  };

  it('is sent at once and refreshed while active, and stops when disabled', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Lease enabled />);
    expect(hub.published).toEqual(['obs.cmd.previews.watch']);
    act(() => vi.advanceTimersByTime(PREVIEW_LEASE_MS * 3));
    expect(hub.published).toHaveLength(4); // one every 5 s
    rerender(<Lease enabled={false} />);
    act(() => vi.advanceTimersByTime(PREVIEW_LEASE_MS * 3));
    expect(hub.published).toHaveLength(4); // nothing more once off
    rerender(<Lease enabled />);
    expect(hub.published).toHaveLength(5); // switched back on
  });
});
