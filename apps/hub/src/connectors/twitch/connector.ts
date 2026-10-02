import type { ConnectorStatus, EventPayload, KnownEventType } from '@streamhub/shared';
import type { Bus } from '../../bus/bus';
import { backoffDelay } from '../../util/backoff';
import { describeError } from '../../util/errors';
import { realTimer, type Timer } from '../../util/timer';
import type { Connector, SocketFactory, SocketLike } from '../types';
import type { TwitchAuth } from './auth';
import {
  normalizeTwitchClear,
  normalizeTwitchDelete,
  normalizeTwitchMessage,
  type TwitchChatEvent,
} from './normalize';

export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
export const TWITCH_SUBSCRIPTIONS = [
  'channel.chat.message',
  'channel.chat.message_delete',
  'channel.chat.clear',
  'channel.chat.clear_user_messages',
] as const;

const KEEPALIVE_GRACE_MS = 5000;
const VALIDATE_EVERY_MS = 60 * 60 * 1000;
const SEEN_LIMIT = 1000;
const RECONNECT_HINT = 'Reconnect Twitch on the Connections page.';

type Frame = {
  metadata?: { message_id?: string; message_type?: string; message_timestamp?: string; subscription_type?: string };
  payload?: {
    session?: { id: string; keepalive_timeout_seconds: number | null; reconnect_url: string | null };
    subscription?: { type?: string; status?: string };
    event?: unknown;
  };
};

export type TwitchConnectorOptions = {
  bus: Bus;
  auth: Pick<TwitchAuth, 'tokens' | 'helix' | 'validate'>;
  createSocket: SocketFactory;
  timer?: Timer;
  rand?: () => number;
  url?: string;
  /** Called when the connector stops because the user must reconnect Twitch. */
  onAuthLost?: (detail: string) => void;
};

/** EventSub WebSocket lifecycle. See docs/connectors/twitch.md §3. */
export class TwitchConnector implements Connector {
  readonly platform = 'twitch' as const;
  private socket: SocketLike | null = null;
  private handover: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: unknown = null;
  private watchdog: unknown = null;
  private validation: unknown = null;
  private keepaliveMs = 10_000;
  private generation = 0;
  private readonly seen = new Set<string>();
  private readonly timer: Timer;
  private readonly rand: () => number;

  constructor(private readonly opts: TwitchConnectorOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
  }

  start() {
    this.shutdown();
    this.stopped = false;
    if (!this.opts.auth.tokens()) {
      this.status('disconnected', 'Connect Twitch on the Connections page');
      return;
    }
    this.open(this.opts.url ?? EVENTSUB_URL, false);
    void this.checkToken();
  }

  async stop() {
    this.shutdown();
    this.status('disconnected');
  }

  private shutdown() {
    this.stopped = true;
    this.generation++;
    for (const handle of [this.retry, this.watchdog, this.validation]) if (handle !== null) this.timer.clear(handle);
    this.retry = this.watchdog = this.validation = null;
    const sockets = [this.socket, this.handover];
    this.socket = this.handover = null;
    sockets.forEach((s) => s?.close(1000));
  }

  /** Stops for good: the user must reconnect Twitch. */
  private authLost(detail: string) {
    this.shutdown();
    this.status('error', detail);
    try {
      this.opts.onAuthLost?.(detail);
    } catch (err) {
      console.warn('[twitch] onAuthLost failed:', describeError(err));
    }
  }

  private open(url: string, isHandover: boolean) {
    if (!isHandover) {
      this.status('connecting');
      this.closeHandover();
    }
    const socket = this.opts.createSocket(url);
    if (isHandover) this.handover = this.socket;
    this.socket = socket;
    socket.onmessage = (ev) => this.onFrame(socket, String(ev.data));
    socket.onclose = (ev) => this.onSocketClosed(socket, ev.code);
    // A close event follows an error and drives the reconnect; without a listener `ws` would throw.
    socket.onerror = () => {};
    if (!isHandover) this.armWatchdog();
  }

  private closeHandover() {
    const h = this.handover;
    this.handover = null;
    h?.close(1000);
  }

  private onFrame(socket: SocketLike, text: string) {
    try {
      this.handleFrame(socket, text);
    } catch (err) {
      console.warn('[twitch] failed to handle frame:', describeError(err));
    }
  }

  private handleFrame(socket: SocketLike, text: string) {
    if (socket !== this.socket && socket !== this.handover) return;
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (socket === this.socket) this.armWatchdog();
    switch (frame.metadata?.message_type) {
      case 'session_welcome':
        void this.onWelcome(socket, frame);
        return;
      case 'notification':
        this.onNotification(frame);
        return;
      case 'session_reconnect': {
        const url = frame.payload?.session?.reconnect_url;
        if (url && socket === this.socket) this.open(url, true);
        return;
      }
      case 'revocation':
        this.onRevocation(frame);
        return;
    }
  }

  private async onWelcome(socket: SocketLike, frame: Frame) {
    const session = frame.payload?.session;
    if (!session || socket !== this.socket) return;
    this.keepaliveMs = (session.keepalive_timeout_seconds ?? 10) * 1000;
    this.armWatchdog();
    if (this.handover) {
      // Subscriptions carry over to the reconnect socket.
      const old = this.handover;
      this.handover = null;
      old.close(1000);
      return;
    }
    try {
      await this.subscribeAll(session.id);
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.status('live');
    } catch (err) {
      if (socket !== this.socket) return;
      this.status('error', describeError(err));
      this.dropSocket();
      this.scheduleReconnect();
    }
  }

  private async subscribeAll(sessionId: string) {
    const userId = this.opts.auth.tokens()?.userId;
    if (!userId) throw new Error('Twitch is not connected');
    for (const type of TWITCH_SUBSCRIPTIONS) {
      const res = await this.opts.auth.helix('/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          version: '1',
          condition: { broadcaster_user_id: userId, user_id: userId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });
      if (res.status !== 202 && res.status !== 409) {
        throw new Error(`Subscribing to ${type} failed (${res.status})`);
      }
    }
  }

  private onNotification(frame: Frame) {
    const id = frame.metadata?.message_id;
    const event = frame.payload?.event as Record<string, unknown> | undefined;
    if (!id || !event || this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);

    switch (frame.metadata?.subscription_type) {
      case 'channel.chat.message':
        this.publish(
          'chat.message',
          normalizeTwitchMessage(event as unknown as TwitchChatEvent, frame.metadata.message_timestamp ?? ''),
        );
        return;
      case 'channel.chat.message_delete':
        this.publish('chat.deleted', normalizeTwitchDelete(event as { message_id: string }));
        return;
      case 'channel.chat.clear':
      case 'channel.chat.clear_user_messages':
        this.publish('chat.cleared', normalizeTwitchClear(event as { target_user_id?: string }));
        return;
    }
  }

  private onRevocation(frame: Frame) {
    const sub = frame.payload?.subscription;
    if (sub?.status === 'authorization_revoked' || sub?.status === 'user_removed') {
      this.authLost(`Twitch access was revoked. ${RECONNECT_HINT}`);
      return;
    }
    console.warn(`[twitch] subscription ${sub?.type} revoked: ${sub?.status}`);
  }

  private onSocketClosed(socket: SocketLike, code: number) {
    if (socket === this.handover) {
      this.handover = null;
      return;
    }
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearWatchdog();
    this.closeHandover();
    if (this.stopped) return;
    this.status('connecting', `Twitch closed the connection (${code})`);
    this.scheduleReconnect();
  }

  private dropSocket() {
    const s = this.socket;
    this.socket = null;
    this.clearWatchdog();
    this.closeHandover();
    s?.close(1000);
  }

  private armWatchdog() {
    this.clearWatchdog();
    this.watchdog = this.timer.set(() => {
      this.watchdog = null;
      if (this.stopped) return;
      this.status('connecting', 'Twitch keepalive timed out');
      this.dropSocket();
      this.scheduleReconnect();
    }, this.keepaliveMs + KEEPALIVE_GRACE_MS);
  }

  private clearWatchdog() {
    if (this.watchdog !== null) this.timer.clear(this.watchdog);
    this.watchdog = null;
  }

  private scheduleReconnect() {
    if (this.stopped || this.retry !== null) return;
    this.retry = this.timer.set(() => {
      this.retry = null;
      if (this.stopped) return;
      try {
        this.open(this.opts.url ?? EVENTSUB_URL, false);
      } catch (err) {
        console.warn('[twitch] failed to open socket:', describeError(err));
        this.scheduleReconnect();
      }
    }, backoffDelay(this.attempt++, this.rand));
  }

  private async checkToken() {
    const generation = this.generation;
    const ok = await this.opts.auth.validate().catch(() => false);
    if (this.stopped || generation !== this.generation) return;
    if (!ok) {
      this.authLost(`Twitch login expired. ${RECONNECT_HINT}`);
      return;
    }
    this.validation = this.timer.set(() => {
      this.validation = null;
      if (!this.stopped) void this.checkToken();
    }, VALIDATE_EVERY_MS);
  }

  private status(status: ConnectorStatus, detail?: string) {
    this.publish('platform.status', { platform: 'twitch', status, ...(detail ? { detail } : {}) });
  }

  private publish<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    const result = this.opts.bus.publish({ type, payload, source: 'connector:twitch' });
    if (!result.ok) console.warn(`[twitch] dropped invalid ${type}: ${result.error}`);
  }
}
