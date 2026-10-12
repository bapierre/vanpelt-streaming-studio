// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { createPreviewsStore } from '../usePreviews';
import { ScenePanel } from './ScenePanel';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** A hub that records subscriptions so tests can push events the way the real one would. */
function fakeHub() {
  const handlers: Array<{ topic: string; h: (e: Envelope) => void }> = [];
  const client: HubClient = {
    on: (topic, h) => (handlers.push({ topic, h }), () => {}),
    onStatus: () => () => {},
    onError: () => () => {},
    history: async () => [],
    publish: () => {},
    close: () => {},
  };
  const emit = (type: string, payload: unknown) =>
    act(() => {
      handlers
        .filter((x) => type.startsWith(x.topic))
        .forEach((x) => x.h({ id: '1', ts: 0, source: 'hub', type, payload } as Envelope));
    });
  return { client, emit };
}

const SCENES = ['Showtime', 'Screen time', 'Host close-up', 'GoPro wide'];

function renderPanel(over: Partial<Parameters<typeof ScenePanel>[0]> = {}) {
  const { client, emit } = fakeHub();
  const onSelect = vi.fn();
  const onTogglePreviews = vi.fn();
  const props = {
    scenes: SCENES,
    current: 'Screen time',
    disabled: false,
    previews: createPreviewsStore(client),
    previewsOn: true,
    onTogglePreviews,
    onSelect,
    ...over,
  } as const;
  const ui = render(<ScenePanel {...props} />);
  return { ...ui, emit, onSelect, onTogglePreviews, props };
}

describe('ScenePanel', () => {
  it('shows each scene as a tile with its keyboard hint, and marks the program one', () => {
    const { container } = renderPanel();
    const tiles = [...container.querySelectorAll('.scene-tile')] as HTMLButtonElement[];
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(SCENES);
    expect(tiles.map((t) => t.querySelector('.scene-key')?.textContent)).toEqual(['1', '2', '3', '4']);
    expect(tiles[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(tiles[1]!.className).toContain('program');
    expect(screen.getByText('On air')).toBeTruthy();
    expect(tiles[1]!.title).toBe('Screen time (press 2)');
    fireEvent.click(screen.getByRole('button', { name: 'Host close-up' }));
    expect(tiles.map((t) => t.disabled)).toEqual([false, false, false, false]);
  });

  it('cuts a scene when its tile is clicked', () => {
    const { onSelect } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'GoPro wide' }));
    expect(onSelect).toHaveBeenCalledWith('GoPro wide');
  });

  it('cuts with the digits 1–9, but not while typing, with modifiers, or past the list', () => {
    const { onSelect } = renderPanel();
    fireEvent.keyDown(window, { key: '3' });
    expect(onSelect).toHaveBeenCalledWith('Host close-up');
    fireEvent.keyDown(window, { key: '1' });
    expect(onSelect).toHaveBeenCalledWith('Showtime');
    onSelect.mockClear();
    fireEvent.keyDown(window, { key: '9' }); // only four scenes
    fireEvent.keyDown(window, { key: '0' });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: '2', metaKey: true }); // ⌘2 switches tabs, not scenes
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores digits typed into a field', () => {
    const { onSelect } = renderPanel();
    render(<input aria-label="note" />);
    fireEvent.keyDown(screen.getByLabelText('note'), { key: '2' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does nothing while OBS is not ready', () => {
    const { onSelect } = renderPanel({ disabled: true });
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: '2' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the newest thumbnail per scene and falls back to the plain tile', () => {
    const { container, emit } = renderPanel();
    emit('obs.scene.preview', { scene: 'Showtime', image: 'data:image/jpeg;base64,QUJD', capturedAt: 1 });
    emit('obs.scene.preview', { scene: 'Showtime', image: 'data:image/jpeg;base64,V1la', capturedAt: 2 });
    const showtime = screen.getByRole('button', { name: 'Showtime' });
    expect(showtime.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,V1la');
    expect(screen.getByRole('button', { name: 'Screen time' }).querySelector('img')).toBeNull();
    expect(showtime.querySelector('.scene-img-shade')).toBeTruthy();
    expect(container.querySelectorAll('.scene-img')).toHaveLength(1);
  });

  it('hides thumbnails when previews are switched off', () => {
    const { emit } = renderPanel({ previewsOn: false });
    emit('obs.scene.preview', { scene: 'Showtime', image: 'data:image/jpeg;base64,QUJD', capturedAt: 1 });
    expect(screen.getByRole('button', { name: 'Showtime' }).querySelector('img')).toBeNull();
  });

  it('switches previews from the header toggle', () => {
    const { onTogglePreviews } = renderPanel();
    const toggle = screen.getByRole('switch', { name: 'Scene previews' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onTogglePreviews).toHaveBeenCalledWith(false);
    cleanup();
    renderPanel({ previewsOn: false });
    expect(screen.getByRole('switch', { name: 'Scene previews' }).getAttribute('aria-checked')).toBe('false');
  });
});
