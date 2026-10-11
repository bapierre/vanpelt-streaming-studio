import { topicMatches, type Envelope, type ErrorCode, type ServerMessage } from '@streamhub/shared';

export type HubStatus = 'connecting' | 'open' | 'closed';
export type WebSocketCtor = new (url: string) => WebSocket;

export type ConnectOptions = {
  /** Defaults to `ws(s)://<page host>/ws`. */
  url?: string;
  module?: string;
  token?: string;
  WebSocketImpl?: WebSocketCtor;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Publishes/history queued while disconnected are dropped after this long (default 5 s), so a stale command never fires late. */
  queueTtlMs?: number;
};

export interface HubClient {
  on(topic: string, handler: (e: Envelope) => void): () => void;
  publish(type: string, payload?: unknown): void;
  history(topic: string, limit?: number): Promise<Envelope[]>;
  onStatus(handler: (s: HubStatus) => void): () => void;
  onError(handler: (code: ErrorCode, message: string) => void): () => void;
  close(): void;
}

const OPEN = 1;
const MAX_OUTBOX = 100;

function defaultUrl(): string {
  const loc = globalThis.location;
  if (!loc) throw new Error('connect(): pass `url` when not running in a browser');
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

export function connect(opts: ConnectOptions = {}): HubClient {
  const Impl = opts.WebSocketImpl ?? globalThis.WebSocket;
  const baseMs = opts.reconnectBaseMs ?? 1000;
  const maxMs = opts.reconnectMaxMs ?? 30_000;
  const queueTtlMs = opts.queueTtlMs ?? 5000;
  const url = new URL(opts.url ?? defaultUrl());
  if (opts.module) url.searchParams.set('module', opts.module);
  if (opts.token) url.searchParams.set('token', opts.token);

  const handlers = new Map<string, Set<(e: Envelope) => void>>();
  const statusHandlers = new Set<(s: HubStatus) => void>();
  const errorHandlers = new Set<(code: ErrorCode, message: string) => void>();
  const pending = new Map<string, { resolve: (e: Envelope[]) => void; reject: (err: Error) => void }>();
  const outbox: Array<{ text: string; at: number; reqId?: string }> = [];

  let ws: WebSocket | null = null;
  let status: HubStatus = 'connecting';
  let attempt = 0;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reqSeq = 0;

  const setStatus = (s: HubStatus) => {
    status = s;
    statusHandlers.forEach((h) => h(s));
  };

  /** A queued history request that never gets sent must not leave its promise pending. */
  const dropRequest = (reqId: string) => {
    pending.get(reqId)?.reject(new Error('history request dropped while disconnected'));
    pending.delete(reqId);
  };

  /** Sends now if open; otherwise queues (publish/history only; subscriptions are replayed on open). */
  const send = (msg: object, reqId?: string) => {
    const text = JSON.stringify(msg);
    if (ws?.readyState === OPEN) ws.send(text);
    else if (outbox.length < MAX_OUTBOX) outbox.push({ text, at: Date.now(), reqId });
    else if (reqId) dropRequest(reqId);
  };
  const sendIfOpen = (msg: object) => {
    if (ws?.readyState === OPEN) ws.send(JSON.stringify(msg));
  };

  const onMessage = (msg: ServerMessage) => {
    if ('op' in msg) {
      if (msg.op === 'error') errorHandlers.forEach((h) => h(msg.code, msg.message));
      if (msg.op === 'history-result') {
        pending.get(msg.reqId)?.resolve(msg.events);
        pending.delete(msg.reqId);
      }
      return;
    }
    for (const [topic, set] of handlers) {
      if (topicMatches([topic], msg.type)) set.forEach((h) => h(msg));
    }
  };

  const open = () => {
    setStatus('connecting');
    const sock = new Impl(url.toString());
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      setStatus('open');
      if (handlers.size) sock.send(JSON.stringify({ op: 'subscribe', topics: [...handlers.keys()] }));
      const now = Date.now();
      for (const { text, at, reqId } of outbox.splice(0)) {
        if (now - at <= queueTtlMs) sock.send(text);
        else if (reqId) dropRequest(reqId);
      }
    };
    sock.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setStatus('closed');
      pending.forEach((p) => p.reject(new Error('hub connection closed')));
      pending.clear();
      if (closed) return;
      const ceiling = Math.min(maxMs, baseMs * 2 ** attempt++);
      retry = setTimeout(open, ceiling / 2 + Math.random() * (ceiling / 2));
    };
  };

  open();

  return {
    on(topic, handler) {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        sendIfOpen({ op: 'subscribe', topics: [topic] });
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0 && handlers.get(topic) === set) {
          handlers.delete(topic);
          sendIfOpen({ op: 'unsubscribe', topics: [topic] });
        }
      };
    },
    publish(type, payload = {}) {
      send({ op: 'publish', event: { type, payload } });
    },
    history(topic, limit = 50) {
      const reqId = `h${++reqSeq}`;
      return new Promise<Envelope[]>((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        send({ op: 'history', reqId, topic, limit }, reqId);
      });
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      handler(status);
      return () => statusHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    close() {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}

export type ReloadReconnectOptions = {
  /** Hub health endpoint; the hub serves the page, so a relative URL works. */
  healthUrl?: string;
  /** This many refused connections in a row before the page considers its token stale (default 3). */
  failuresBeforeReload?: number;
  /** Never reload more than once per this interval (default 60 s), persisted in sessionStorage. */
  minReloadIntervalMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload?: () => void;
  fetchImpl?: typeof fetch;
};

const RELOAD_MARK = 'streamhub:reload-at';

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Recovers from a hub restart: the hub mints a fresh module token per run and injects it into the
 * page it serves, so a page kept open across the restart (an OBS Browser Source) gets every
 * reconnect refused. When the socket keeps failing while the hub itself answers, reload once to
 * pick up the fresh token. While the hub itself is down the client's normal backoff keeps trying.
 * Returns an unsubscribe function.
 */
export function reconnectByReload(client: Pick<HubClient, 'onStatus'>, opts: ReloadReconnectOptions = {}): () => void {
  const healthUrl = opts.healthUrl ?? '/health';
  const threshold = opts.failuresBeforeReload ?? 3;
  const minIntervalMs = opts.minReloadIntervalMs ?? 60_000;
  const storage = opts.storage === undefined ? safeStorage() : opts.storage;
  const reload = opts.reload ?? (() => globalThis.location?.reload());
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  let failures = 0;
  let checking = false;
  return client.onStatus((status) => {
    if (status === 'open') {
      failures = 0;
      return;
    }
    if (status !== 'closed' || checking || !fetchImpl) return;
    if (++failures < threshold) return;
    checking = true;
    failures = 0;
    void fetchImpl(healthUrl, { cache: 'no-store' })
      .then((res) => {
        // The hub answers but refuses the socket: the token is stale, reload for a fresh one.
        if (!res.ok) return;
        const last = Number(storage?.getItem(RELOAD_MARK) ?? 0);
        if (Date.now() - last < minIntervalMs) return;
        storage?.setItem(RELOAD_MARK, String(Date.now()));
        reload();
      })
      .catch(() => {
        // The hub itself is down; keep the normal reconnect backoff.
      })
      .finally(() => {
        checking = false;
      });
  });
}
