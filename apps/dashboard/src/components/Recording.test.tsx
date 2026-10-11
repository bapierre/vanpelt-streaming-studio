// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingSession } from '@streamhub/shared';
import { diskWarning, formatBytes } from '../recording';
import { initialState } from '../state';
import { RecordControls } from './RecordControls';
import { RecordingPanel } from './RecordingPanel';
import { StatusBar } from './StatusBar';

const GB = 1024 ** 3;
const session = (over: Partial<RecordingSession> = {}): RecordingSession => ({
  output: 'stopped',
  directory: '/Users/me/Movies',
  cameras: [],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('RecordControls', () => {
  it('starts recording with one click', () => {
    const onStart = vi.fn();
    render(<RecordControls recording={session()} disabled={false} onStart={onStart} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('stops only after a confirming second click', () => {
    const onStop = vi.fn();
    render(
      <RecordControls recording={session({ output: 'recording', startedAt: 0 })} disabled={false} onStart={vi.fn()} onStop={onStop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    expect(onStop).not.toHaveBeenCalled();
    wait(600);
    fireEvent.click(screen.getByRole('button', { name: 'Click again to STOP recording' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('ignores a fast double-click on stop', () => {
    const onStop = vi.fn();
    render(
      <RecordControls recording={session({ output: 'recording', startedAt: 0 })} disabled={false} onStart={vi.fn()} onStop={onStop} />,
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    wait(100);
    fireEvent.click(button);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('disarms when the recording stops underneath', () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <RecordControls recording={session({ output: 'recording', startedAt: 0 })} disabled={false} onStart={vi.fn()} onStop={onStop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    rerender(<RecordControls recording={session()} disabled={false} onStart={vi.fn()} onStop={onStop} />);
    rerender(
      <RecordControls recording={session({ output: 'recording', startedAt: 0 })} disabled={false} onStart={vi.fn()} onStop={onStop} />,
    );
    wait(600);
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    expect(onStop).not.toHaveBeenCalled();
  });

  it('is disabled without OBS, without state, or while changing', () => {
    const { rerender } = render(<RecordControls recording={session()} disabled onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    rerender(<RecordControls recording={null} disabled={false} onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    rerender(<RecordControls recording={session({ output: 'starting' })} disabled={false} onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
  });
});

describe('RecordingPanel', () => {
  it('shows each camera, why one cannot record, and the files of the last take', () => {
    render(
      <RecordingPanel
        recording={session({
          cameras: [
            { id: 'wide', name: 'Wide', mode: 'obs', iso: 'no-plugin', detail: 'Install the OBS "Source Record" plugin' },
            { id: 'gopro', name: 'GoPro', mode: 'both', iso: 'ready', card: 'ready' },
          ],
          lastSession: {
            endedAt: 1,
            files: [
              { kind: 'program', label: 'Program', location: '/Users/me/Movies/2026-10-11 20-00-00.mkv' },
              { kind: 'card', cameraId: 'gopro', label: 'GoPro (card)', location: "On GoPro's card" },
            ],
          },
        })}
      />,
    );
    const text = screen.getByRole('heading', { name: 'Recording' }).parentElement!.textContent;
    expect(text).toContain('file: plugin missing');
    expect(text).toContain('Source Record');
    expect(text).toContain('card: ready');
    expect(text).toContain('2026-10-11 20-00-00.mkv');
    expect(text).toContain("On GoPro's card");
    expect(text).toContain('in /Users/me/Movies');
  });

  it('warns about low disk space', () => {
    render(
      <RecordingPanel
        recording={session({ disk: { path: '/x', freeBytes: 12 * GB, level: 'low', minutesLeft: 95 } })}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Disk space low: 12 GB free (about 1 h 35 min left)');
  });
});

describe('StatusBar recording', () => {
  it('shows REC with the take length and a disk warning', () => {
    vi.setSystemTime(65_000);
    render(
      <StatusBar
        state={{ ...initialState, hubConnected: true, obs: { connected: true } }}
        recording={session({
          output: 'recording',
          startedAt: 0,
          disk: { path: '/x', freeBytes: 3 * GB, level: 'critical' },
        })}
      />,
    );
    const text = screen.getByRole('contentinfo').textContent ?? '';
    expect(text).toContain('rec · 0:01:05');
    expect(text).toContain('Disk almost full: 3.0 GB free');
  });

  it('claims nothing about recording while OBS is disconnected', () => {
    render(
      <StatusBar
        state={{ ...initialState, hubConnected: true, obs: { connected: false } }}
        recording={session({ output: 'recording', startedAt: 0 })}
      />,
    );
    expect(screen.getByRole('contentinfo').textContent).not.toContain('rec');
  });
});

describe('recording helpers', () => {
  it('formats sizes and stays quiet when the disk is fine', () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB');
    expect(formatBytes(250 * GB)).toBe('250 GB');
    expect(diskWarning(session({ disk: { path: '/x', freeBytes: 250 * GB, level: 'ok' } }))).toBeNull();
    expect(diskWarning(null)).toBeNull();
  });
});
