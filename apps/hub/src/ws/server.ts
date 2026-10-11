import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientOpSchema,
  topicMatches,
  type Envelope,
  type ModuleManifest,
  type ErrorCode,
  type ServerMessage,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';

/** Event prefixes a dashboard client may publish. Module pages follow their manifest (moduleRole). */
export const DASHBOARD_PUBLISHABLE = [
  'obs.cmd.',
  'show.',
  'connections.cmd.',
  'camera.cmd.',
  'destinations.cmd.',
  'audio.cmd.',
  'recording.cmd.',
  'headsets.cmd.',
  'alert.cmd.',
  'goal.cmd.',
];
/** Events that may carry secrets: handled inside the hub, never sent to any client. */
export const NEVER_FORWARDED = ['connections.cmd.', 'destinations.cmd.'];
/** Hub ↔ camera driver traffic: only the owning driver connection sees it. */
export const DRIVER_ONLY = ['camera.driver.'];
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Returns the camera ids the driver owns, or null when the token is not valid for that driver. */
export type AuthorizeDriver = (driverId: string, token: string) => string[] | null;

/** Returns the module's manifest, or null when the token is not the one its pages were served with. */
export type AuthorizeModule = (moduleId: string, token: string) => ModuleManifest | null;

export type WsOptions = {
  bus: Bus;
  allowedOrigins: string[];
  authorizeDriver?: AuthorizeDriver;
  authorizeModule?: AuthorizeModule;
};

type Role = {
  source: string;
  canPublish(type: string, payload: unknown): boolean;
  canReceive(event: Envelope): boolean;
};

const startsWithAny = (type: string, prefixes: string[]) => prefixes.some((p) => type.startsWith(p));

const dashboardRole: Role = {
  source: 'dashboard',
  canPublish: (type) => startsWithAny(type, DASHBOARD_PUBLISHABLE),
  canReceive: (e) => !startsWithAny(e.type, NEVER_FORWARDED) && !startsWithAny(e.type, DRIVER_ONLY),
};

function driverRole(driverId: string, cameraIds: string[]): Role {
  const owns = (payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id;
    return typeof id === 'string' && cameraIds.includes(id);
  };
  return {
    source: `driver:${driverId}`,
    canPublish: (type, payload) => type === 'camera.driver.state' && owns(payload),
    canReceive: (e) => (e.type === 'camera.driver.cmd.set' || e.type === 'camera.driver.cmd.record') && owns(e.payload),
  };
}

/** A module page receives only what its manifest subscribes to and publishes only `module.<id>.*` it declared. */
export function moduleRole(manifest: ModuleManifest): Role {
  const own = `module.${manifest.id}.`;
  return {
    source: `module:${manifest.id}`,
    canPublish: (type) => type.startsWith(own) && topicMatches(manifest.publishes, type),
    canReceive: (e) =>
      topicMatches(manifest.subscribes, e.type) &&
      !startsWithAny(e.type, NEVER_FORWARDED) &&
      !startsWithAny(e.type, DRIVER_ONLY),
  };
}

/** Browsers always send Origin; a missing Origin means a local non-browser client. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

export function attachWebSocket(server: Server, opts: WsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (req, socket, head) => {
    // Compare the raw path: parsing with URL throws on inputs like `//`, and this runs before the Origin check.
    const [pathname, query = ''] = (req.url ?? '/').split('?');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, opts.allowedOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let role = dashboardRole;
    const params = new URLSearchParams(query);
    const driverId = params.get('driver');
    if (driverId !== null) {
      // Drivers are local processes; a browser page must never be able to claim a driver role.
      const cameraIds =
        req.headers.origin === undefined ? opts.authorizeDriver?.(driverId, params.get('token') ?? '') : null;
      if (!cameraIds) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      role = driverRole(driverId, cameraIds);
    }
    const moduleId = params.get('module');
    if (moduleId !== null) {
      const manifest = opts.authorizeModule?.(moduleId, params.get('token') ?? '');
      if (!manifest) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      role = moduleRole(manifest);
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, opts.bus, role));
  });
  return wss;
}

function handleClient(ws: WebSocket, bus: Bus, role: Role) {
  const topics = new Set<string>();
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (code: ErrorCode, message: string) => send({ op: 'error', code, message });

  const unsubscribe = bus.subscribe(['*'], (event) => {
    if (role.canReceive(event) && topicMatches(topics, event.type)) send(event);
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
          if (role.canReceive(event) && !topicMatches(before, event.type)) send(event);
        }
        return;
      }
      case 'unsubscribe':
        op.topics.forEach((t) => topics.delete(t));
        return;
      case 'publish': {
        const { type, payload } = op.event;
        if (!role.canPublish(type, payload)) {
          return fail('forbidden', `clients may not publish ${type}`);
        }
        const result = bus.publish({ type, payload, source: role.source });
        if (!result.ok) fail('bad_payload', result.error);
        return;
      }
      case 'history':
        send({
          op: 'history-result',
          reqId: op.reqId,
          events: bus.history(op.topic, op.limit).filter((e) => role.canReceive(e)),
        });
        return;
    }
  });

  ws.on('close', unsubscribe);
  ws.on('error', () => ws.terminate());
}
