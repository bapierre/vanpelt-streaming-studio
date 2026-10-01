// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamControls } from './StreamControls';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StreamControls', () => {
  it('requires a second click to confirm', () => {
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Click again to GO LIVE' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('stops only after confirmation while live', () => {
    const onStop = vi.fn();
    render(<StreamControls stream={{ state: 'live', startedAt: 0 }} disabled={false} onStart={vi.fn()} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop stream' }));
    fireEvent.click(screen.getByRole('button', { name: 'Click again to STOP stream' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('disarms after the confirm window', () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} confirmMs={1000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    act(() => vi.advanceTimersByTime(1001));
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('is disabled while OBS is unavailable or the stream is changing state', () => {
    const { rerender } = render(
      <StreamControls stream={{ state: 'stopped' }} disabled onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    rerender(<StreamControls stream={{ state: 'starting' }} disabled={false} onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
  });
});
