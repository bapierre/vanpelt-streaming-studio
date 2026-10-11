import type { Envelope, EventPayload } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { ObsSecrets, SecretsStore } from '../secrets/store';
import { describeError } from '../util/errors';
import type { ObsBridge } from './bridge';

type Store = Pick<SecretsStore, 'get' | 'update'>;

/** Saved settings win over `.env`, so a change made in the dashboard survives restarts. */
export function loadObsSettings(store: Pick<SecretsStore, 'get'>, env: ObsSecrets): ObsSecrets {
  return store.get().obs ?? env;
}

export type ObsSettingsDeps = {
  bus: Bus;
  store: Store;
  bridge: Pick<ObsBridge, 'configure'>;
  /** The settings the bridge was started with (see loadObsSettings). */
  initial: ObsSecrets;
};

/** Owns the OBS address and password: publishes retained obs.settings (never the password) and applies connections.cmd.setObs. */
export class ObsSettingsService {
  private settings: ObsSecrets;
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ObsSettingsDeps) {
    this.settings = { ...deps.initial };
  }

  start() {
    this.publish();
    this.unsubscribe = this.deps.bus.subscribe(['connections.cmd.setObs'], (e) => {
      this.queue = this.queue.then(() => this.handle(e));
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once every command received so far has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async handle(e: Envelope) {
    const p = e.payload as EventPayload<'connections.cmd.setObs'>;
    const next: ObsSecrets = { url: p.url, password: p.password ?? this.settings.password };
    this.settings = next;
    try {
      await this.deps.store.update((s) => ({ ...s, obs: next }));
    } catch (err) {
      // Still apply the change for this session; only persistence failed.
      console.warn(`[obs] could not save OBS settings: ${describeError(err)}`);
    }
    this.publish();
    try {
      await this.deps.bridge.configure(next.url, next.password);
    } catch (err) {
      console.warn(`[obs] reconnect with new settings failed: ${describeError(err)}`);
    }
  }

  private publish() {
    this.deps.bus.publish({
      type: 'obs.settings',
      payload: { url: this.settings.url, passwordSet: this.settings.password !== '' },
      source: 'hub',
    });
  }
}
