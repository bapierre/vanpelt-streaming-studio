// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { AudioDevices, AudioState, Envelope, MicState } from '@streamhub/shared';
import { meterPercent, meterZone, micWarning, reduceAudio, type Levels } from '../audio';
import { createLevelsStore, type LevelsStore } from '../levels';
import { Mixer, type AudioActions } from './AudioPanel';
import type { HeadsetActions } from './HeadsetMatrix';
import { SoundTab } from './SoundTab';
import { RANGE_SEND_MS } from './ThrottledRange';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A levels store that never ticks; enough for everything but the meter tests. */
const staticLevels = (levels: Levels = {}): LevelsStore => ({ get: (id) => levels[id], subscribe: () => () => {} });

/** A levels store wired to a fake hub, so tests can emit audio.levels. */
function liveLevels() {
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
  const store = createLevelsStore(client);
  const emit = (levels: Levels) =>
    act(() => handler?.({ id: '1', type: 'audio.levels', ts: 0, source: 'hub', payload: { levels } }));
  return { store, emit };
}

const filters: MicState['filters'] = {
  gain: { enabled: true, db: 0 },
  denoise: { enabled: true, method: 'rnnoise', suppressDb: -30 },
  gate: { enabled: false, openDb: -26, closeDb: -32, attackMs: 25, holdMs: 200, releaseMs: 150 },
  eq: { enabled: false, low: 0, mid: 0, high: 0 },
  compressor: { enabled: true, ratio: 4, thresholdDb: -18, attackMs: 6, releaseMs: 60, outputDb: 0 },
  limiter: { enabled: true, thresholdDb: -3, releaseMs: 60 },
};
const host: MicState = {
  id: 'host',
  name: 'Host',
  input: 'Host mic',
  channel: 'both',
  track: 2,
  status: 'ok',
  live: true,
  volumeDb: 0,
  muted: false,
  monitor: 'off',
  syncOffsetMs: 0,
  filters,
};
const guest: MicState = { ...host, id: 'guest', name: 'Guest', input: 'Wireless', channel: 'right', track: 3 };
const lost: MicState = { ...host, id: 'lost', name: 'Lost', input: 'Old mic', track: null, status: 'missing', detail: 'No input "Old mic" in OBS' };

const state = (mics: MicState[] = [host, guest]): AudioState => ({ mics, targetDb: -20, recordTracks: [1, 2, 3], tracksPending: false });
const devices: AudioDevices = { devices: [{ id: 'usb-1', name: 'USB Mic' }], inputs: ['Desk mic'] };

function actions() {
  return {
    onSet: vi.fn<AudioActions['onSet']>(),
    onSoundcheck: vi.fn<AudioActions['onSoundcheck']>(),
    onTarget: vi.fn<AudioActions['onTarget']>(),
    onAdd: vi.fn<AudioActions['onAdd']>(),
    onRemove: vi.fn<AudioActions['onRemove']>(),
    onNest: vi.fn<AudioActions['onNest']>(),
    onListDevices: vi.fn<AudioActions['onListDevices']>(),
  } satisfies AudioActions;
}

function headsetActions() {
  return {
    onAdd: vi.fn<HeadsetActions['onAdd']>(),
    onUpdate: vi.fn<HeadsetActions['onUpdate']>(),
    onRemove: vi.fn<HeadsetActions['onRemove']>(),
    onSetSend: vi.fn<HeadsetActions['onSetSend']>(),
    onListOutputs: vi.fn<HeadsetActions['onListOutputs']>(),
  } satisfies HeadsetActions;
}

function renderPanel(s: AudioState | null = state(), disabled = false) {
  const a = actions();
  const h = headsetActions();
  render(
    <SoundTab
      state={s}
      devices={devices}
      levels={staticLevels({ host: { rmsDb: -20, peakDb: -4 } })}
      headsets={null}
      disabled={disabled}
      hubConnected={!disabled}
      actions={a}
      headsetActions={h}
    />,
  );
  /** The detail panel of one mic, opened from its strip when needed. */
  const card = (name: string) => {
    if (!screen.queryByRole('article', { name })) fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }));
    return within(screen.getByRole('article', { name }));
  };
  return { a, h, card };
}

describe('Mixer', () => {
  it('mutes and fades the right mic, throttling the fader', () => {
    vi.useFakeTimers();
    const onSet = vi.fn();
    render(<Mixer mics={[host, guest]} levels={staticLevels()} disabled={false} onSet={onSet} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute Guest' }));
    const fader = screen.getByLabelText('Host volume');
    fireEvent.change(fader, { target: { value: '-3' } });
    fireEvent.change(fader, { target: { value: '-6' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    expect(onSet.mock.calls).toEqual([[{ id: 'guest', muted: true }], [{ id: 'host', volumeDb: -6 }]]);
  });

  it('pulls the fader to the bottom as silence and disables missing mics', () => {
    vi.useFakeTimers();
    const onSet = vi.fn();
    render(<Mixer mics={[host, lost]} levels={staticLevels()} disabled={false} onSet={onSet} />);
    expect((screen.getByLabelText('Lost volume') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Host volume'), { target: { value: '-60' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    expect(onSet).toHaveBeenCalledWith({ id: 'host', volumeDb: -100 });
  });

  it('shows a muted mic as pressed and renders nothing without mics', () => {
    const { container, rerender } = render(<Mixer mics={[{ ...host, muted: true }]} levels={staticLevels()} disabled={false} onSet={() => {}} />);
    expect(screen.getByRole('button', { name: 'Unmute Host' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<Mixer mics={[]} levels={staticLevels()} disabled={false} onSet={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('meters follow the levels store, per mic', () => {
    const { store, emit } = liveLevels();
    render(<Mixer mics={[host, guest]} levels={store} disabled={false} onSet={() => {}} />);
    const meters = screen.getAllByRole('meter');
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('-60');
    emit({ host: { rmsDb: -20, peakDb: -4 } });
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('-20');
    // Only the mic that moved updates; the other stays at silence.
    expect(meters[1]!.getAttribute('aria-valuenow')).toBe('-60');
    emit({ host: { rmsDb: -30, peakDb: -10 }, guest: { rmsDb: -12, peakDb: -6 } });
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('-30');
    expect(meters[1]!.getAttribute('aria-valuenow')).toBe('-12');
  });
});

describe('SoundTab console', () => {
  it('has a strip per mic with meter, fader, mute, track and on-air badges', () => {
    vi.useFakeTimers();
    const { a } = renderPanel(state([host, { ...guest, live: false }]));
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    expect(screen.getByText('On air')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute Guest' }));
    fireEvent.change(screen.getByLabelText('Host volume'), { target: { value: '-6' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Sound check Host' }));
    expect(a.onSet.mock.calls).toEqual([[{ id: 'guest', muted: true }], [{ id: 'host', volumeDb: -6 }]]);
    expect(a.onSoundcheck).toHaveBeenCalledWith('host', 'start');
  });

  it('opens and closes the detail panel from the strip', () => {
    renderPanel();
    expect(screen.queryByRole('article')).toBeNull();
    const open = screen.getByRole('button', { name: 'Open Host' });
    fireEvent.click(open);
    expect(screen.getByRole('article', { name: 'Host' })).toBeTruthy();
    expect(open.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Open Guest' }));
    expect(screen.queryByRole('article', { name: 'Host' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Guest' }));
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('asks for output devices for the headsets when it opens', () => {
    const { h } = renderPanel();
    expect(screen.getByRole('heading', { name: 'Headsets' })).toBeTruthy();
    expect(h.onListOutputs).toHaveBeenCalledTimes(1);
  });
});

describe('SoundTab mic details', () => {
  it('summarises the recorded tracks and asks for devices when it opens', () => {
    const { a } = renderPanel();
    expect(screen.getByText(/Stream mix \(track 1\), Host \(track 2\), Guest \(track 3\)/)).toBeTruthy();
    expect(a.onListDevices).toHaveBeenCalledTimes(1);
  });

  it('says when track changes wait for the next recording', () => {
    renderPanel({ ...state(), tracksPending: true, recordDetail: 'Recording format FLV cannot hold extra tracks' });
    expect(screen.getByText(/apply to the next recording/)).toBeTruthy();
    expect(screen.getByText(/FLV/)).toBeTruthy();
  });

  it('shows the split-side hint and the missing reason', () => {
    const { card } = renderPanel(state([host, guest, lost]));
    expect(card('Guest').getByText(/tick Mono/)).toBeTruthy();
    expect(card('Lost').getByText('No input "Old mic" in OBS')).toBeTruthy();
    expect(card('Lost').getByText(/Mix only/)).toBeTruthy();
  });

  it('renames on Enter and removes a mic', () => {
    const { a, card } = renderPanel();
    const name = card('Host').getByLabelText('Mic name');
    fireEvent.change(name, { target: { value: '  Ana  ' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.click(card('Guest').getByRole('button', { name: 'Remove' }));
    expect(a.onSet).toHaveBeenCalledWith({ id: 'host', name: 'Ana' });
    expect(a.onRemove).toHaveBeenCalledWith('guest');
  });

  it('sends monitoring and filter changes as patches', () => {
    const { a, card } = renderPanel();
    const h = card('Host');
    fireEvent.change(h.getByLabelText('Monitoring'), { target: { value: 'monitor' } });
    const gate = within(h.getByRole('group', { name: 'Noise gate' }));
    fireEvent.click(gate.getByRole('switch'));
    fireEvent.change(within(h.getByRole('group', { name: 'Noise suppression' })).getByLabelText('Method'), {
      target: { value: 'speex' },
    });
    expect(a.onSet.mock.calls).toEqual([
      [{ id: 'host', monitor: 'monitor' }],
      [{ id: 'host', filters: { gate: { enabled: true } } }],
      [{ id: 'host', filters: { denoise: { method: 'speex' } } }],
    ]);
    expect((gate.getByLabelText('Open at') as HTMLInputElement).disabled).toBe(true);
  });

  it('throttles filter sliders', () => {
    vi.useFakeTimers();
    const { a, card } = renderPanel();
    const ratio = within(card('Host').getByRole('group', { name: 'Compressor' })).getByLabelText('Ratio');
    fireEvent.change(ratio, { target: { value: '6' } });
    fireEvent.change(ratio, { target: { value: '8' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    expect(a.onSet.mock.calls).toEqual([[{ id: 'host', filters: { compressor: { ratio: 8 } } }]]);
  });

  it('starts and cancels a sound check and reports the result', () => {
    const listening = { ...host, soundcheck: { state: 'listening' as const, until: 0 } };
    const done = { ...guest, soundcheck: { state: 'done' as const, measuredDb: -31, gainDb: 11, detail: 'Peaks clipped' } };
    const failed = { ...lost, id: 'x', name: 'X', status: 'ok' as const, detail: undefined, soundcheck: { state: 'failed' as const, detail: 'Heard no speech' } };
    const { a, card } = renderPanel(state([listening, done, failed]));
    fireEvent.click(card('Host').getByRole('button', { name: 'Cancel sound check' }));
    fireEvent.click(card('Guest').getByRole('button', { name: 'Sound check' }));
    expect(a.onSoundcheck.mock.calls).toEqual([
      ['host', 'cancel'],
      ['guest', 'start'],
    ]);
    expect(card('Host').getByText(/Listening/)).toBeTruthy();
    expect(card('Guest').getByText(/measured -31 dBFS; gain set to \+11.0 dB/)).toBeTruthy();
    expect(card('Guest').getByText(/Peaks clipped/)).toBeTruthy();
    expect(card('X').getByText('Heard no speech')).toBeTruthy();
    // Dynamics are bypassed while listening, so their switches are locked.
    const hostCard = card('Host');
    expect((within(hostCard.getByRole('group', { name: 'Limiter' })).getByRole('switch') as HTMLInputElement).disabled).toBe(true);
    expect((within(hostCard.getByRole('group', { name: 'EQ' })).getByRole('switch') as HTMLInputElement).disabled).toBe(false);
  });

  it('adds a mic from a device or an existing input', () => {
    const { a } = renderPanel(state([]));
    expect(screen.getByText(/No mics yet/)).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add mic' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name (who uses it)'), { target: { value: 'Guest 2' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'device:usb-1' } });
    fireEvent.change(screen.getByLabelText('Side'), { target: { value: 'left' } });
    fireEvent.click(add);
    fireEvent.change(screen.getByLabelText('Name (who uses it)'), { target: { value: 'Desk' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'input:Desk mic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add mic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add mics to all scenes' }));
    expect(a.onAdd.mock.calls).toEqual([
      [{ name: 'Guest 2', channel: 'left', from: { kind: 'device', device: 'usb-1' } }],
      [{ name: 'Desk', channel: 'both', from: { kind: 'input', input: 'Desk mic' } }],
    ]);
    expect(a.onNest).toHaveBeenCalled();
  });

  it('waits for the hub and does not ask for devices while disconnected', () => {
    const { a } = renderPanel(null, true);
    expect(screen.getByText(/Waiting for the hub/)).toBeTruthy();
    expect(a.onListDevices).not.toHaveBeenCalled();
  });
});

describe('audio helpers', () => {
  it('maps levels to the meter', () => {
    expect([meterPercent(-100), meterPercent(-30), meterPercent(0), meterPercent(5)]).toEqual([0, 50, 100, 100]);
    expect([meterZone(-30), meterZone(-12), meterZone(-3)]).toEqual(['ok', 'loud', 'hot']);
  });

  it('explains why a mic may not be heard', () => {
    expect(micWarning({ ...host, status: 'offline' })).toBe('OBS is not connected');
    expect(micWarning({ ...host, live: false })).toMatch(/Not in the live scene/);
    expect(micWarning(host)).toBeUndefined();
  });

  it('keeps the latest audio state and devices', () => {
    const ev = (type: string, payload: unknown) => ({ id: '1', type, ts: 0, source: 'hub', payload });
    let v = reduceAudio({ state: null, devices: null }, ev('audio.state', state()));
    v = reduceAudio(v, ev('audio.devices', devices));
    expect(v.state?.mics).toHaveLength(2);
    expect(v.devices?.inputs).toEqual(['Desk mic']);
    expect(reduceAudio(v, ev('chat.message', {}))).toBe(v);
  });
});
