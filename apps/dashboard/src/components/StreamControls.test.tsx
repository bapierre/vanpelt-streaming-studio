// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamControls } from './StreamControls';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('StreamControls', () => {
  it('requires a second click to confirm', () => {
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(onStart).not.toHaveBeenCalled();
    wait(600);
    fireEvent.click(screen.getByRole('button', { name: 'Click again to GO LIVE' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('says "anyway" when pre-flight found problems, and still goes live', () => {
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} problems={2} onStart={onStart} onStop={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Start stream' }).title).toBe('Pre-flight found 2 problems');
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    wait(600);
    fireEvent.click(screen.getByRole('button', { name: 'Click again to GO LIVE anyway' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('stops only after confirmation while live', () => {
    const onStop = vi.fn();
    render(<StreamControls stream={{ state: 'live', startedAt: 0 }} disabled={false} onStart={vi.fn()} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop stream' }));
    wait(600);
    fireEvent.click(screen.getByRole('button', { name: 'Click again to STOP stream' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('ignores a fast double-click', () => {
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    wait(100);
    fireEvent.click(button);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('disarms when the stream state changes underneath', () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={vi.fn()} onStop={onStop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    rerender(<StreamControls stream={{ state: 'live', startedAt: 0 }} disabled={false} onStart={vi.fn()} onStop={onStop} />);
    wait(600);
    fireEvent.click(screen.getByRole('button', { name: 'Stop stream' }));
    expect(onStop).not.toHaveBeenCalled();
  });

  it('disarms after the confirm window', () => {
    const onStart = vi.fn();
    render(<StreamControls stream={{ state: 'stopped' }} disabled={false} onStart={onStart} onStop={vi.fn()} confirmMs={1000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    wait(1001);
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
