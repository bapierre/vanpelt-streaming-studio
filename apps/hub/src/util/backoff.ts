/** Exponential backoff with equal jitter: attempt 0 → 0.5–1 s, capped at 30–60 s. */
export function backoffDelay(
  attempt: number,
  rand: () => number = Math.random,
  baseMs = 1000,
  maxMs = 60_000,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}
