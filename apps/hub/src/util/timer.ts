export type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

/** Node treats a setTimeout delay above 2^31 - 1 ms as 1 ms, which would turn a long retry wait into a busy loop. */
const MAX_DELAY_MS = 2_147_483_647;

export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, Math.min(Math.max(ms || 0, 0), MAX_DELAY_MS)),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
