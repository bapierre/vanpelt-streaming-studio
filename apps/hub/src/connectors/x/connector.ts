import type {
  ConnectorStatus,
  EventPayload,
  KnownEventType,
  PlatformLive,
} from '@streamhub/shared';
import type { Bus } from '../../bus/bus';
import { backoffDelay } from '../../util/backoff';
import { describeError } from '../../util/errors';
import { realTimer, type Timer } from '../../util/timer';
import type { Connector } from '../types';
import { XApiError, type XApi, type XBroadcast, type XIngest } from './api';
import { XAuthError } from './auth';

const RATE_BACKOFF_MS = 60_000;
/** Without Livestream API access X answers 403 to every poll; asking again rarely is enough. */
const FORBIDDEN_RETRY_MS = 10 * 60_000;
const CLEARED: PlatformLive = { platform: 'x', ingest: 'unknown', broadcast: 'none' };

export type XConnectorOptions = {
  bus: Bus;
  tokens: {
    accessToken(): Promise<string>;
    invalidate(): void;
    connected(): boolean;
    userId(): string | undefined;
  };
  api: XApi;
  timer?: Timer;
  rand?: () => number;
  /** Poll cadence while a broadcast is running or scheduled. */
  livePollMs?: number;
  /** Poll cadence with no running broadcast (every read is billed). */
  idlePollMs?: number;
  /** Called when the connector stops because the user must reconnect X. */
  onAuthLost?: (detail: string) => void;
};

/** Polls the streamer's X broadcasts and reports them as platform.live. No chat. See docs/connectors/x.md. */
export class XConnector implements Connector {
  readonly platform = 'x' as const;
  private stopped = true;
  private generation = 0;
  private pending: unknown = null;
  private attempt = 0;
  /** Cleared for the rest of the session once X refuses the allowlist-only sources endpoint. */
  private ingestReadable = true;
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly livePollMs: number;
  private readonly idlePollMs: number;

  constructor(private readonly opts: XConnectorOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.livePollMs = opts.livePollMs ?? 15_000;
    this.idlePollMs = opts.idlePollMs ?? 30_000;
  }

  start() {
    this.shutdown();
    this.stopped = false;
    this.generation++;
    this.attempt = 0;
    this.ingestReadable = true;
    if (!this.opts.tokens.connected()) {
      this.status('disconnected', 'Connect X in Settings → X');
      this.publish('platform.live', CLEARED);
      return;
    }
    this.status('connecting');
    void this.poll();
  }

  async stop() {
    this.shutdown();
    this.status('disconnected');
    this.publish('platform.live', CLEARED);
  }

  private shutdown() {
    this.stopped = true;
    this.generation++;
    if (this.pending !== null) this.timer.clear(this.pending);
    this.pending = null;
  }

  private later(fn: () => void, ms: number) {
    if (this.pending !== null) this.timer.clear(this.pending);
    const gen = this.generation;
    this.pending = this.timer.set(() => {
      this.pending = null;
      if (!this.stopped && gen === this.generation) this.guard('timer callback failed:', fn);
    }, ms);
  }

  /** Runs fn, logging instead of throwing: nothing in here may crash the hub. */
  private guard(label: string, fn: () => void) {
    try {
      fn();
    } catch (err) {
      console.warn(`[x] ${label}`, describeError(err));
    }
  }

  private async poll() {
    const gen = this.generation;
    try {
      const token = await this.opts.tokens.accessToken();
      const b = await this.opts.api.latestBroadcast(token);
      const ingest = await this.readIngest(token, b);
      if (gen !== this.generation) return;
      this.attempt = 0;
      this.publish('platform.live', toLive(b, ingest));
      if (b?.broadcast === 'running') this.status('live', b.title);
      else
        this.status(
          'offline',
          b?.broadcast === 'scheduled'
            ? 'Broadcast not started yet'
            : 'No live broadcast right now',
        );
      const active = b?.broadcast === 'running' || b?.broadcast === 'scheduled';
      this.later(() => void this.poll(), active ? this.livePollMs : this.idlePollMs);
    } catch (err) {
      if (gen === this.generation) this.guard('error handling failed:', () => this.onError(err));
    }
  }

  /** Ingest is optional extra detail: its failures never fail the poll. */
  private async readIngest(token: string, b: XBroadcast | null): Promise<XIngest> {
    const userId = this.opts.tokens.userId();
    if (!this.ingestReadable || !userId) return 'unknown';
    try {
      return await this.opts.api.ingest(token, userId, b?.sourceId);
    } catch (err) {
      if (err instanceof XApiError && err.kind === 'unavailable') this.ingestReadable = false;
      return 'unknown';
    }
  }

  private onError(err: unknown) {
    if (err instanceof XAuthError) {
      this.shutdown();
      this.status('error', err.message);
      this.publish('platform.live', CLEARED);
      this.guard('onAuthLost failed:', () => this.opts.onAuthLost?.(err.message));
      return;
    }
    const delay = backoffDelay(this.attempt++, this.rand);
    const retry = () => void this.poll();
    if (!(err instanceof XApiError)) {
      this.status('error', describeError(err));
      this.later(retry, delay);
      return;
    }
    switch (err.kind) {
      case 'auth':
        this.opts.tokens.invalidate();
        this.status('connecting', err.message);
        return this.later(retry, delay);
      case 'forbidden': {
        const detail = 'X has not enabled Livestream API access for this app (see docs/setup/x.md)';
        this.status('error', detail);
        this.publish('platform.live', { ...CLEARED, detail });
        return this.later(retry, FORBIDDEN_RETRY_MS);
      }
      case 'rate':
        this.status('error', err.message);
        return this.later(retry, Math.max(RATE_BACKOFF_MS, err.retryAfterMs ?? 0, delay));
      default:
        this.status('error', err.message);
        return this.later(retry, delay);
    }
  }

  private status(status: ConnectorStatus, detail?: string) {
    this.publish('platform.status', { platform: 'x', status, ...(detail ? { detail } : {}) });
  }

  private publish<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    try {
      const result = this.opts.bus.publish({ type, payload, source: 'connector:x' });
      if (!result.ok) console.warn(`[x] dropped invalid ${type}: ${result.error}`);
    } catch (err) {
      console.warn(`[x] publish of ${type} failed:`, describeError(err));
    }
  }
}

function toLive(b: XBroadcast | null, ingest: XIngest): PlatformLive {
  if (!b) return { platform: 'x', ingest, broadcast: 'none' };
  return {
    platform: 'x',
    ingest,
    broadcast: b.broadcast,
    ...(b.viewers !== undefined ? { viewers: b.viewers } : {}),
    ...(b.title ? { title: b.title } : {}),
    ...(b.startedAt ? { startedAt: b.startedAt } : {}),
  };
}
