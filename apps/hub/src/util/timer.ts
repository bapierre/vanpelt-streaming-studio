export type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
