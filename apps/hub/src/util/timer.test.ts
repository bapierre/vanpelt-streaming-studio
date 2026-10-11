import { afterEach, describe, expect, it, vi } from 'vitest';
import { realTimer } from './timer';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('realTimer', () => {
  it('clamps the delay to the signed 32-bit setTimeout range', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never);
    realTimer.set(() => {}, 3_000_000_000);
    realTimer.set(() => {}, Number.POSITIVE_INFINITY);
    realTimer.set(() => {}, -50);
    realTimer.set(() => {}, Number.NaN);
    realTimer.set(() => {}, 250);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([2_147_483_647, 2_147_483_647, 0, 0, 250]);
  });
});
