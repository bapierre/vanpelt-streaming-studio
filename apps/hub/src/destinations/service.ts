import type { Envelope, EventPayload, StreamDestination } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { ObsBridge } from '../obs/bridge';
import type { SecretsStore } from '../secrets/store';
import { describeError } from '../util/errors';

export type DestinationsDeps = {
  bus: Bus;
  store: Pick<SecretsStore, 'get' | 'update'>;
  obs: Pick<ObsBridge, 'call' | 'isConnected'>;
};

type StreamServiceSettings = {
  streamServiceType?: string;
  streamServiceSettings?: { server?: string; key?: string };
};

/** Saved RTMP destinations; can write one into OBS's main stream output. Stream keys never reach logs or `detail`. */
export class DestinationsService {
  private destinations: StreamDestination[] = [];
  private inObs: string | null = null;
  private obsKeySet: boolean | undefined;
  private detail: string | undefined;
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DestinationsDeps) {}

  start() {
    this.destinations = this.deps.store.get().destinations ?? [];
    this.publish();
    this.unsubscribe = this.deps.bus.subscribe(['destinations.cmd.', 'obs.connection'], (e) => {
      if (e.type === 'obs.connection' && !(e.payload as EventPayload<'obs.connection'>).connected) return;
      this.queue = this.queue.then(() => this.handle(e));
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once every event received so far has been handled. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async handle(e: Envelope) {
    try {
      switch (e.type) {
        case 'obs.connection':
          return await this.syncFromObs();
        case 'destinations.cmd.save':
          return await this.save(e.payload as EventPayload<'destinations.cmd.save'>);
        case 'destinations.cmd.remove':
          return await this.remove((e.payload as EventPayload<'destinations.cmd.remove'>).id);
        case 'destinations.cmd.useInObs':
          return await this.useInObs((e.payload as EventPayload<'destinations.cmd.useInObs'>).id);
      }
    } catch (err) {
      const extraKey = (e.payload as { key?: unknown }).key;
      const detail = this.redact(`${e.type} failed: ${describeError(err)}`, typeof extraKey === 'string' ? [extraKey] : []);
      console.warn(`[destinations] ${detail}`);
      this.fail(detail);
    }
  }

  private async save(dest: StreamDestination) {
    const previous = this.destinations.find((d) => d.id === dest.id);
    const next = previous
      ? this.destinations.map((d) => (d.id === dest.id ? dest : d))
      : [...this.destinations, dest];
    await this.persist(next);
    // OBS still holds the old server/key, so it no longer uses this destination.
    if (this.inObs === dest.id && previous && (previous.server !== dest.server || previous.key !== dest.key)) {
      this.inObs = null;
    }
    this.succeed();
  }

  private async remove(id: string) {
    await this.persist(this.destinations.filter((d) => d.id !== id));
    if (this.inObs === id) this.inObs = null;
    this.succeed();
  }

  private async useInObs(id: string) {
    const dest = this.destinations.find((d) => d.id === id);
    if (!dest) return this.fail(`No saved destination "${id}".`);
    if (!this.deps.obs.isConnected()) return this.fail('OBS is not connected.');
    const status = (await this.deps.obs.call('GetStreamStatus')) as { outputActive: boolean };
    if (status.outputActive) return this.fail('Stop the stream in OBS before switching destinations.');
    await this.deps.obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: dest.server, key: dest.key },
    });
    this.inObs = id;
    this.obsKeySet = dest.key !== '';
    this.succeed();
  }

  private async syncFromObs() {
    const current = (await this.deps.obs.call('GetStreamServiceSettings')) as StreamServiceSettings;
    const { server, key } = current.streamServiceSettings ?? {};
    this.inObs = this.destinations.find((d) => d.server === server && d.key === key)?.id ?? null;
    this.obsKeySet = Boolean(key);
    this.succeed();
  }

  private async persist(next: StreamDestination[]) {
    await this.deps.store.update((s) => ({ ...s, destinations: next }));
    this.destinations = next;
  }

  private redact(text: string, extraKeys: string[]): string {
    let out = text;
    for (const key of [...this.destinations.map((d) => d.key), ...extraKeys]) {
      if (key) out = out.split(key).join('***');
    }
    return out;
  }

  private succeed() {
    this.detail = undefined;
    this.publish();
  }

  private fail(detail: string) {
    this.detail = detail;
    this.publish();
  }

  private publish() {
    this.deps.bus.publish({
      type: 'destinations.list',
      payload: {
        destinations: this.destinations,
        inObs: this.inObs,
        ...(this.obsKeySet !== undefined ? { obsKeySet: this.obsKeySet } : {}),
        ...(this.detail ? { detail: this.detail } : {}),
      },
      source: 'hub',
    });
  }
}
