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
  const outbox: Array<{ text: string; at: number }> = [];

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

  /** Sends now if open; otherwise queues (publish/history only; subscriptions are replayed on open). */
  const send = (msg: object) => {
    const text = JSON.stringify(msg);
    if (ws?.readyState === OPEN) ws.send(text);
    else if (outbox.length < MAX_OUTBOX) outbox.push({ text, at: Date.now() });
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
      for (const { text, at } of outbox.splice(0)) if (now - at <= queueTtlMs) sock.send(text);
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
        send({ op: 'history', reqId, topic, limit });
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
