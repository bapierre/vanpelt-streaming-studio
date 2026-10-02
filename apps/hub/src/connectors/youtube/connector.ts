import type { ConnectorStatus, EventPayload, KnownEventType } from '@streamhub/shared';
import type { Bus } from '../../bus/bus';
import { backoffDelay } from '../../util/backoff';
import { describeError } from '../../util/errors';
import { realTimer, type Timer } from '../../util/timer';
import type { Connector } from '../types';
import { YouTubeApiError, type ChatStream, type YouTubeApi } from './api';
import { YouTubeAuthError, type TokenSource } from './auth';
import { normalizeYouTubeItem, type YtListResponse } from './normalize';

const BACKLOG_MS = 5000;
/** A stream must stay open this long before its responses count as proof of health. */
const STABLE_MS = 30_000;
const RATE_BACKOFF_MS = 60_000;
const SEEN_LIMIT = 2000;
const MIN_POLL_MS = 1000;

export type YouTubeConnectorOptions = {
  bus: Bus;
  tokens: TokenSource & { connected(): boolean };
  api: YouTubeApi;
  channel: () => string;
  timer?: Timer;
  rand?: () => number;
  now?: () => number;
  offlineCheckMs?: number;
  streamFailuresBeforePolling?: number;
  /** Called when the connector stops because the user must reconnect YouTube. */
  onAuthLost?: (detail: string) => void;
};

type ActiveChat = {
  liveChatId: string;
  title: string;
  pageToken?: string;
  connectedAt: number;
  mode: 'stream' | 'poll';
  failures: number;
};

/** Finds the live broadcast, streams its chat (polling as fallback). See docs/connectors/youtube.md. */
export class YouTubeConnector implements Connector {
  readonly platform = 'youtube' as const;
  private stopped = true;
  private generation = 0;
  private pending: unknown = null;
  private stream: ChatStream | null = null;
  private chat: ActiveChat | null = null;
  private attempt = 0;
  private current: ConnectorStatus | null = null;
  private readonly seen = new Set<string>();
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly offlineCheckMs: number;
  private readonly maxStreamFailures: number;

  constructor(private readonly opts: YouTubeConnectorOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.offlineCheckMs = opts.offlineCheckMs ?? 60_000;
    this.maxStreamFailures = opts.streamFailuresBeforePolling ?? 3;
  }

  start() {
    this.shutdown();
    this.stopped = false;
    this.generation++;
    if (!this.opts.tokens.connected()) {
      this.status('disconnected', 'Connect YouTube on the Connections page');
      return;
    }
    void this.findChat();
  }

  async stop() {
    this.shutdown();
    this.status('disconnected');
  }

  private shutdown() {
    this.stopped = true;
    this.generation++;
    if (this.pending !== null) this.timer.clear(this.pending);
    this.pending = null;
    this.dropStream();
    this.chat = null;
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
      console.warn(`[youtube] ${label}`, describeError(err));
    }
  }

  /** Cancels the stream (it does not close itself on terminal events) and forgets it. */
  private dropStream() {
    const stream = this.stream;
    this.stream = null;
    if (stream) this.guard('stream cancel failed:', () => stream.cancel());
  }

  private async findChat() {
    const gen = this.generation;
    try {
      const token = await this.opts.tokens.accessToken();
      const found = await this.opts.api.findActiveChat(token);
      if (gen !== this.generation) return;
      this.attempt = 0;
      if (!found) {
        this.status('offline', 'No live broadcast right now');
        this.later(() => void this.findChat(), this.offlineCheckMs);
        return;
      }
      this.chat = { ...found, connectedAt: this.now(), mode: 'stream', failures: 0 };
      this.status('connecting', found.title);
      void this.connectChat();
    } catch (err) {
      if (gen === this.generation)
        this.guard('error handling failed:', () => this.onError(err, () => void this.findChat()));
    }
  }

  private async connectChat() {
    const chat = this.chat;
    if (!chat) return;
    let token: string;
    try {
      token = await this.opts.tokens.accessToken();
    } catch (err) {
      if (this.chat === chat)
        this.guard('error handling failed:', () =>
          this.onError(err, () => void this.connectChat()),
        );
      return;
    }
    if (this.chat !== chat) return;
    if (chat.mode === 'poll') {
      void this.poll(chat, token);
      return;
    }
    const openedAt = this.now();
    let terminated = false;
    const fail = (err: unknown) => {
      if (this.chat !== chat || terminated) return;
      terminated = true;
      this.dropStream();
      if (!(err instanceof YouTubeApiError) || err.kind === 'other') {
        chat.failures++;
        if (chat.failures >= this.maxStreamFailures) {
          chat.mode = 'poll';
          console.warn('[youtube] streamList keeps failing; switching to polling');
        }
      }
      this.onError(err, () => void this.connectChat());
    };
    let handle: ChatStream;
    try {
      handle = this.opts.api.streamChat(token, chat.liveChatId, chat.pageToken, {
        onResponse: (r) => {
          if (this.chat !== chat || terminated) return;
          this.guard('stream response failed:', () => {
            if (this.now() - openedAt >= STABLE_MS) {
              chat.failures = 0;
              this.attempt = 0;
            }
            this.handleResponse(chat, r);
          });
        },
        onError: (err) => this.guard('stream error handling failed:', () => fail(err)),
        onEnd: () =>
          this.guard('stream end handling failed:', () => {
            if (this.chat !== chat || terminated) return;
            terminated = true;
            this.dropStream();
            this.later(() => void this.connectChat(), backoffDelay(this.attempt++, this.rand));
          }),
      });
    } catch (err) {
      this.guard('stream setup failed:', () =>
        fail(new YouTubeApiError(describeError(err), 'other')),
      );
      return;
    }
    if (terminated || this.chat !== chat) {
      // Terminal event fired during setup, or we were shut down meanwhile.
      this.guard('stream cancel failed:', () => handle.cancel());
      return;
    }
    this.stream = handle;
  }

  private async poll(chat: ActiveChat, token: string) {
    try {
      const r = await this.opts.api.pollChat(token, chat.liveChatId, chat.pageToken);
      if (this.chat !== chat) return;
      this.attempt = 0;
      this.handleResponse(chat, r);
      if (this.chat === chat) {
        this.later(
          () => void this.connectChat(),
          Math.max(MIN_POLL_MS, r.pollingIntervalMillis ?? 5000),
        );
      }
    } catch (err) {
      if (this.chat === chat)
        this.guard('error handling failed:', () =>
          this.onError(err, () => void this.connectChat()),
        );
    }
  }

  private handleResponse(chat: ActiveChat, r: YtListResponse) {
    if (r.nextPageToken) chat.pageToken = r.nextPageToken;
    if (this.current !== 'live') this.status('live', chat.title);
    const channel = this.opts.channel();
    for (const item of r.items ?? []) {
      const n = normalizeYouTubeItem(item, channel, this.now);
      if (!n) continue;
      if (n.kind === 'ended') {
        this.endChat();
        return;
      }
      if (n.kind === 'deleted') this.publish('chat.deleted', { id: n.id });
      if (n.kind === 'cleared')
        this.publish('chat.cleared', { platform: 'youtube', authorId: n.authorId });
      if (n.kind === 'message') {
        if (this.seen.has(n.message.id)) continue;
        this.seen.add(n.message.id);
        if (this.seen.size > SEEN_LIMIT)
          this.seen.delete(this.seen.values().next().value as string);
        if (n.message.sentAt < chat.connectedAt - BACKLOG_MS) continue;
        this.publish('chat.message', n.message);
      }
    }
    if (r.offlineAt) this.endChat();
  }

  /** Leaves the current chat and looks for a broadcast again on the offline cadence. */
  private endChat(detail = 'Broadcast ended') {
    this.dropStream();
    this.chat = null;
    this.status('offline', detail);
    this.later(() => void this.findChat(), this.offlineCheckMs);
  }

  private onError(err: unknown, retry: () => void) {
    if (err instanceof YouTubeAuthError) {
      this.shutdown();
      this.status('error', err.message);
      this.guard('onAuthLost failed:', () => this.opts.onAuthLost?.(err.message));
      return;
    }
    if (err instanceof YouTubeApiError) {
      if (err.kind === 'ended') {
        this.endChat();
        return;
      }
      if (err.kind === 'chatDisabled') {
        this.endChat('Live chat is turned off for this broadcast');
        return;
      }
      if (err.kind === 'auth') this.opts.tokens.invalidate();
      this.status(err.kind === 'rate' ? 'error' : 'connecting', err.message);
    } else {
      this.status('error', describeError(err));
    }
    const delay = backoffDelay(this.attempt++, this.rand);
    const rate = err instanceof YouTubeApiError && err.kind === 'rate';
    this.later(retry, rate ? Math.max(RATE_BACKOFF_MS, delay) : delay);
  }

  private status(status: ConnectorStatus, detail?: string) {
    this.current = status;
    this.publish('platform.status', { platform: 'youtube', status, ...(detail ? { detail } : {}) });
  }

  private publish<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    try {
      const result = this.opts.bus.publish({ type, payload, source: 'connector:youtube' });
      if (!result.ok) console.warn(`[youtube] dropped invalid ${type}: ${result.error}`);
    } catch (err) {
      // A failing subscriber/bus must not break state handling (e.g. scheduling the reconnect).
      console.warn(`[youtube] publish of ${type} failed:`, describeError(err));
    }
  }
}
