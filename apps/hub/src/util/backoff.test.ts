import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

describe('backoffDelay', () => {
  it('starts around 1s', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(0, () => 0)).toBe(500);
  });
  it('doubles per attempt', () => {
    expect(backoffDelay(3, () => 1)).toBe(8000);
  });
  it('caps at 60s', () => {
    expect(backoffDelay(10, () => 1)).toBe(60_000);
    expect(backoffDelay(10, () => 0)).toBe(30_000);
    expect(backoffDelay(1000, () => 1)).toBe(60_000);
  });
});
