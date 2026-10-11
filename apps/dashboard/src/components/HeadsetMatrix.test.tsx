// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeadsetsState, HeadsetState, MicState } from '@streamhub/shared';
import { HeadsetMatrix, type HeadsetActions } from './HeadsetMatrix';
import { RANGE_SEND_MS } from './ThrottledRange';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mic = (id: string, name: string) => ({ id, name }) as MicState;
const mics = [mic('host', 'Host'), mic('guest', 'Guest')];
const guestHp: HeadsetState = {
  id: 'guest',
  name: 'Guest headset',
  device: 'USB Audio',
  owner: 'guest',
  masterDb: 0,
  muted: false,
  status: 'ok',
  sends: { 'mic:host': { on: true, db: 0 }, 'mic:guest': { on: true, db: -6 }, 'obs:Music': { on: false, db: -12 } },
};
const state = (over: Partial<HeadsetsState> = {}): HeadsetsState => ({
  plugin: true,
  outputs: ['MacBook Pro Speakers', 'USB Audio'],
  sources: [
    { key: 'mic:host', name: 'Host', kind: 'mic' },
    { key: 'mic:guest', name: 'Guest', kind: 'mic' },
    { key: 'obs:Music', name: 'Music', kind: 'obs' },
  ],
  headsets: [guestHp],
  ...over,
});

function setup(s: HeadsetsState | null = state(), disabled = false) {
  const a = {
    onAdd: vi.fn<HeadsetActions['onAdd']>(),
    onUpdate: vi.fn<HeadsetActions['onUpdate']>(),
    onRemove: vi.fn<HeadsetActions['onRemove']>(),
    onSetSend: vi.fn<HeadsetActions['onSetSend']>(),
    onListOutputs: vi.fn<HeadsetActions['onListOutputs']>(),
  } satisfies HeadsetActions;
  render(<HeadsetMatrix state={s} mics={mics} disabled={disabled} actions={a} />);
  return a;
}

describe('HeadsetMatrix', () => {
  it('has a row per source, mics first, and a column per headset', () => {
    setup();
    const rows = screen.getAllByRole('rowheader').map((r) => r.textContent);
    expect(rows).toEqual(['Host', 'Guest', 'Music · OBS']);
    expect(screen.getByRole('columnheader', { name: 'Guest headset' })).toBeTruthy();
  });

  it('marks the owner hearing themselves', () => {
    setup();
    const guestRow = screen.getByRole('rowheader', { name: 'Guest' }).closest('tr')!;
    const hostRow = screen.getByRole('rowheader', { name: 'Host' }).closest('tr')!;
    expect(within(guestRow).getByText('self')).toBeTruthy();
    expect(within(hostRow).queryByText('self')).toBeNull();
  });

  it('switches a send on and off', () => {
    const a = setup();
    const music = screen.getByRole('switch', { name: 'Music in Guest headset' });
    expect(music.getAttribute('aria-checked')).toBe('false');
    expect((screen.getByLabelText('Music level in Guest headset') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(music);
    fireEvent.click(screen.getByRole('switch', { name: 'Host in Guest headset' }));
    expect(a.onSetSend.mock.calls).toEqual([
      [{ id: 'guest', source: 'obs:Music', on: true }],
      [{ id: 'guest', source: 'mic:host', on: false }],
    ]);
  });

  it('throttles send and master levels, never above 0 dB', () => {
    vi.useFakeTimers();
    const a = setup();
    const level = screen.getByLabelText('Host level in Guest headset') as HTMLInputElement;
    expect(level.max).toBe('0');
    expect(level.min).toBe('-60');
    fireEvent.change(level, { target: { value: '-3' } });
    fireEvent.change(level, { target: { value: '-9' } });
    fireEvent.change(screen.getByLabelText('Guest headset master level'), { target: { value: '-4' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    expect(a.onSetSend.mock.calls).toEqual([[{ id: 'guest', source: 'mic:host', db: -9 }]]);
    expect(a.onUpdate.mock.calls).toEqual([[{ id: 'guest', masterDb: -4 }]]);
  });

  it('mutes, re-assigns, moves and removes a headset', () => {
    const a = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Mute Guest headset' }));
    fireEvent.change(screen.getByLabelText('Who wears Guest headset'), { target: { value: '' } });
    const output = screen.getByLabelText('Guest headset output');
    fireEvent.change(output, { target: { value: ' MacBook Pro Speakers ' } });
    fireEvent.keyDown(output, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Guest headset' }));
    expect(a.onUpdate.mock.calls).toEqual([
      [{ id: 'guest', muted: true }],
      [{ id: 'guest', owner: null }],
      [{ id: 'guest', device: 'MacBook Pro Speakers' }],
    ]);
    expect(a.onRemove).toHaveBeenCalledWith('guest');
  });

  it('adds a headset with a listed or typed output and lists outputs when it opens', () => {
    const a = setup(state({ headsets: [] }));
    expect(a.onListOutputs).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).toBeNull();
    const add = screen.getByRole('button', { name: 'Add headset' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Host phones ' } });
    fireEvent.change(screen.getByLabelText('Worn by'), { target: { value: 'host' } });
    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'Scarlett 2i2' } });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh outputs' }));
    expect(a.onAdd).toHaveBeenCalledWith({ name: 'Host phones', device: 'Scarlett 2i2', owner: 'host' });
    expect(a.onListOutputs).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  it('offers the listed outputs and explains when they cannot be listed', () => {
    const { container } = render(
      <HeadsetMatrix
        state={state({ outputs: [], outputsDetail: 'Output devices can only be listed on macOS.' })}
        mics={mics}
        disabled={false}
        actions={{ onAdd: vi.fn(), onUpdate: vi.fn(), onRemove: vi.fn(), onSetSend: vi.fn(), onListOutputs: vi.fn() }}
      />,
    );
    expect(screen.getByText(/only be listed on macOS/)).toBeTruthy();
    expect(container.querySelectorAll('datalist option')).toHaveLength(0);
    cleanup();
    const { container: c2 } = render(
      <HeadsetMatrix state={state()} mics={mics} disabled={false} actions={{ onAdd: vi.fn(), onUpdate: vi.fn(), onRemove: vi.fn(), onSetSend: vi.fn(), onListOutputs: vi.fn() }} />,
    );
    expect([...c2.querySelectorAll('datalist')][0]!.querySelectorAll('option')).toHaveLength(2);
  });

  it('links to the plugin when Audio Monitor is missing', () => {
    setup(state({ plugin: false, headsets: [{ ...guestHp, status: 'no-plugin', detail: 'Install the Audio Monitor plugin in OBS' }] }));
    const link = within(screen.getByRole('alert')).getByRole('link', { name: 'Install Audio Monitor' }) as HTMLAnchorElement;
    expect(link.href).toMatch(/^https:\/\/obsproject\.com\//);
    expect(screen.getByText('Install the Audio Monitor plugin in OBS')).toBeTruthy();
  });

  it('waits for the hub and locks everything while it is away', () => {
    const a = setup(null, true);
    expect(screen.getByText(/Waiting for the hub/)).toBeTruthy();
    expect(a.onListOutputs).not.toHaveBeenCalled();
    cleanup();
    setup(state(), true);
    expect((screen.getByRole('switch', { name: 'Host in Guest headset' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
