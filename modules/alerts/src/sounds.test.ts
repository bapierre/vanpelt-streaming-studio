import { describe, expect, it, vi } from 'vitest';
import { playSound, SOUNDS } from './sounds';

function fakeCtx(state: AudioContextState = 'running') {
  const oscillators: Array<{
    type: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const peaks: number[] = [];
  const param = (track?: number[]) => ({
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn((v: number) => track?.push(v)),
  });
  const ctx = {
    currentTime: 10,
    destination: {},
    state,
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    createOscillator: vi.fn(() => {
      const osc = {
        type: '',
        frequency: param(),
        connect: vi.fn((n: unknown) => n),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn(() => ({ gain: param(peaks), connect: vi.fn((n: unknown) => n) })),
  };
  return { ctx: ctx as unknown as Parameters<typeof playSound>[2], raw: ctx, oscillators, peaks };
}

describe('playSound', () => {
  it('plays one oscillator per note, scaled by volume', () => {
    const { ctx, oscillators, peaks } = fakeCtx();
    playSound('fanfare', 1, ctx);
    expect(oscillators).toHaveLength(SOUNDS.fanfare.length);
    expect(oscillators.every((o) => o.type === 'triangle' && o.start.mock.calls[0]![0] >= 10)).toBe(
      true,
    );
    const loud = Math.max(...peaks);

    const quiet = fakeCtx();
    playSound('fanfare', 0.5, quiet.ctx);
    expect(Math.max(...quiet.peaks)).toBeCloseTo(loud / 2);
  });

  it('stays silent for none, zero volume or no audio support', () => {
    const { ctx, raw } = fakeCtx();
    playSound('none', 1, ctx);
    playSound('chime', 0, ctx);
    playSound('chime', 1, null);
    expect(raw.createOscillator).not.toHaveBeenCalled();
  });

  it('resumes a suspended context', () => {
    const { ctx, raw } = fakeCtx('suspended');
    playSound('pop', 1, ctx);
    expect(raw.resume).toHaveBeenCalled();
  });

  it('does not create an AudioContext for silent alerts', () => {
    const ctor = vi.fn();
    vi.stubGlobal('AudioContext', ctor);
    try {
      playSound('none', 1);
      playSound('chime', 0);
      expect(ctor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('suspends the context after the last note, and a new sound postpones it', () => {
    vi.useFakeTimers();
    try {
      const { ctx, raw } = fakeCtx();
      playSound('pop', 1, ctx);
      vi.advanceTimersByTime(10_000);
      expect(raw.suspend).toHaveBeenCalledTimes(1);

      const second = fakeCtx();
      playSound('coin', 1, second.ctx);
      playSound('coin', 1, second.ctx);
      vi.advanceTimersByTime(10_000);
      expect(second.raw.suspend).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
