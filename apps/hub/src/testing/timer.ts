import type { Timer } from '../util/timer';

export class FakeTimer implements Timer {
  queue: Array<{ fn: () => void; ms: number }> = [];
  set(fn: () => void, ms: number) {
    const entry = { fn, ms };
    this.queue.push(entry);
    return entry;
  }
  clear(handle: unknown) {
    this.queue = this.queue.filter((e) => e !== handle);
  }
  /** Runs (and removes) the first pending timer with exactly this delay. */
  fire(ms: number) {
    const i = this.queue.findIndex((e) => e.ms === ms);
    if (i < 0) throw new Error(`no timer pending at ${ms}ms (pending: ${this.queue.map((e) => e.ms).join(', ')})`);
    const [entry] = this.queue.splice(i, 1);
    entry!.fn();
  }
  has(ms: number) {
    return this.queue.some((e) => e.ms === ms);
  }
}

/** Lets chained promises and immediates run. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
