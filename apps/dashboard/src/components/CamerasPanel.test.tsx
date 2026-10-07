// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraState } from '@streamhub/shared';
import { cameraList, reduceCameras } from '../cameras';
import { CamerasPanel, CameraSwitcher, RANGE_SEND_MS } from './CamerasPanel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const gopro: CameraState = {
  id: 'gopro',
  name: 'GoPro',
  driver: 'camera-gopro',
  status: 'streaming',
  scene: 'GoPro',
  onAir: false,
  telemetry: { battery: 64, overheating: true },
  controls: [
    { key: 'lens', label: 'Lens', kind: 'select', value: '0', options: [{ value: '0', label: 'Wide' }, { value: '4', label: 'Linear' }] },
    { key: 'webcam', label: 'Webcam stream', kind: 'toggle', value: true },
    { key: 'zoom', label: 'Digital zoom', kind: 'range', value: 0, min: 0, max: 100, step: 1, disabled: 'Applying a change…' },
    { key: 'obs.brightness', label: 'Brightness', kind: 'range', value: 0, min: -1, max: 1, step: 0.01 },
    { key: 'obs.reset', label: 'Reset picture', kind: 'action' },
  ],
};
const sony: CameraState = {
  id: 'sony',
  name: 'Sony A6400',
  driver: null,
  status: 'error',
  scene: 'Sony',
  onAir: false,
  obsDetail: 'Scene "Sony" not found in OBS',
  controls: [],
};

function renderPanel(cameras = [gopro, sony]) {
  const onTake = vi.fn();
  const onSet = vi.fn();
  render(<CamerasPanel cameras={cameras} disabled={false} onTake={onTake} onSet={onSet} />);
  return { onTake, onSet, card: (name: string) => within(screen.getByRole('article', { name })) };
}

describe('CamerasPanel', () => {
  it('shows status, telemetry and groups device and OBS controls', () => {
    const { card } = renderPanel();
    const g = card('GoPro');
    expect(g.getByText('streaming')).toBeTruthy();
    expect(g.getByText('battery 64%')).toBeTruthy();
    expect(g.getByText('overheating')).toBeTruthy();
    expect(within(g.getByRole('group', { name: 'Camera' })).getByLabelText('Lens')).toBeTruthy();
    expect(within(g.getByRole('group', { name: 'Picture (OBS)' })).getByLabelText('Brightness')).toBeTruthy();
  });

  it('sends take and control changes for the right camera', () => {
    const { card, onTake, onSet } = renderPanel();
    const g = card('GoPro');
    fireEvent.click(g.getByRole('button', { name: 'Take' }));
    fireEvent.change(g.getByLabelText('Lens'), { target: { value: '4' } });
    fireEvent.click(g.getByRole('switch'));
    fireEvent.click(g.getByRole('button', { name: 'Reset picture' }));
    expect(onTake).toHaveBeenCalledWith('gopro');
    expect(onSet.mock.calls).toEqual([
      ['gopro', 'lens', '4'],
      ['gopro', 'webcam', false],
      ['gopro', 'obs.reset', null],
    ]);
  });

  it('disables take with the reason when the OBS scene is missing', () => {
    const { card } = renderPanel();
    const s = card('Sony A6400');
    expect((s.getByRole('button', { name: 'Take' }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.getByText('Scene "Sony" not found in OBS')).toBeTruthy();
    expect(s.getByText(/OBS only/)).toBeTruthy();
  });

  it('greys out a control the camera reports as unavailable', () => {
    const { card } = renderPanel();
    const zoom = card('GoPro').getByLabelText('Digital zoom') as HTMLInputElement;
    expect(zoom.disabled).toBe(true);
    expect(card('GoPro').getByText('Applying a change…')).toBeTruthy();
  });

  it('throttles slider drags to one send per interval with the latest value', () => {
    vi.useFakeTimers();
    const { card, onSet } = renderPanel();
    const slider = card('GoPro').getByLabelText('Brightness');
    fireEvent.change(slider, { target: { value: '0.1' } });
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.change(slider, { target: { value: '0.3' } });
    expect(onSet).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    expect(onSet.mock.calls).toEqual([['gopro', 'obs.brightness', 0.3]]);
  });

  it('explains how to add cameras when none are configured', () => {
    renderPanel([]);
    expect(screen.getByText(/cameras\.json/)).toBeTruthy();
  });
});

describe('CameraSwitcher', () => {
  it('marks the on-air camera and only lets usable cameras be taken', () => {
    const onTake = vi.fn();
    render(<CameraSwitcher cameras={[{ ...gopro, onAir: true }, sony]} disabled={false} onTake={onTake} />);
    const on = screen.getByRole('button', { name: /GoPro/ }) as HTMLButtonElement;
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Sony/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing without cameras', () => {
    const { container } = render(<CameraSwitcher cameras={[]} disabled={false} onTake={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('reduceCameras', () => {
  it('keeps the latest state per camera, sorted by name', () => {
    const ev = (payload: CameraState) => ({ id: '1', type: 'camera.state', ts: 0, source: 'hub', payload });
    let s = reduceCameras({}, ev(sony));
    s = reduceCameras(s, ev(gopro));
    s = reduceCameras(s, ev({ ...gopro, status: 'ready' }));
    expect(cameraList(s).map((c) => [c.name, c.status])).toEqual([
      ['GoPro', 'ready'],
      ['Sony A6400', 'error'],
    ]);
    expect(reduceCameras(s, { ...ev(gopro), type: 'obs.scene.changed' })).toBe(s);
  });
});
