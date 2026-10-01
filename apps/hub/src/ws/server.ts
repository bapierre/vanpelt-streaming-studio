import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientOpSchema,
  topicMatches,
  type ErrorCode,
  type ServerMessage,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';

/** Event prefixes a dashboard client may publish. Modules get their own rules in M4. */
export const DASHBOARD_PUBLISHABLE = ['obs.cmd.', 'show.'];
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type WsOptions = { bus: Bus; allowedOrigins: string[] };

/** Browsers always send Origin; a missing Origin means a local non-browser client. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

export function attachWebSocket(server: Server, opts: WsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, opts.allowedOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, opts.bus));
  });
  return wss;
}

function handleClient(ws: WebSocket, bus: Bus) {
  const topics = new Set<string>();
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (code: ErrorCode, message: string) => send({ op: 'error', code, message });

  const unsubscribe = bus.subscribe(['*'], (event) => {
    if (topicMatches(topics, event.type)) send(event);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return fail('bad_op', 'binary frames are not supported');
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return fail('bad_json', 'message is not valid JSON');
    }
    const parsed = ClientOpSchema.safeParse(json);
    if (!parsed.success) return fail('bad_op', parsed.error.issues[0]?.message ?? 'invalid op');
    const op = parsed.data;

    switch (op.op) {
      case 'subscribe': {
        const fresh = op.topics.filter((t) => !topics.has(t));
        const before = [...topics];
        fresh.forEach((t) => topics.add(t));
        for (const event of bus.retainedFor(fresh)) {
          if (!topicMatches(before, event.type)) send(event);
        }
        return;
      }
      case 'unsubscribe':
        op.topics.forEach((t) => topics.delete(t));
        return;
      case 'publish': {
        const { type, payload } = op.event;
        if (!DASHBOARD_PUBLISHABLE.some((p) => type.startsWith(p))) {
          return fail('forbidden', `clients may not publish ${type}`);
        }
        const result = bus.publish({ type, payload, source: 'dashboard' });
        if (!result.ok) fail('bad_payload', result.error);
        return;
      }
      case 'history':
        send({ op: 'history-result', reqId: op.reqId, events: bus.history(op.topic, op.limit) });
        return;
    }
  });

  ws.on('close', unsubscribe);
  ws.on('error', () => ws.terminate());
}
