import type { PlatformLive } from '@streamhub/shared';

const API = 'https://api.x.com/2';
const BROADCAST_FIELDS = 'id,state,title,total_watching,start_ms,created_at_ms,source_id';
/** Each returned broadcast is a billed resource, so only look at the few newest. */
const MAX_BROADCASTS = 5;

/**
 * `auth`: the token was rejected (refresh and retry). `forbidden`: this app may not use the endpoint.
 * `unavailable`: the endpoint is not open to this app (sources are allowlist-only). `rate`: 429.
 */
export type XApiErrorKind = 'auth' | 'forbidden' | 'unavailable' | 'rate' | 'other';

export class XApiError extends Error {
  constructor(
    message: string,
    readonly kind: XApiErrorKind,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type XBroadcast = {
  broadcast: Exclude<PlatformLive['broadcast'], 'none'>;
  title?: string;
  viewers?: number;
  startedAt?: number;
  sourceId?: string;
};

export type XIngest = PlatformLive['ingest'];

export interface XApi {
  me(token: string): Promise<{ id: string; username: string }>;
  /** The broadcast that matters now: a running one, else the newest. Null when the account has none. */
  latestBroadcast(token: string): Promise<XBroadcast | null>;
  /** Throws XApiError `unavailable` when X does not let this app read stream sources. */
  ingest(token: string, userId: string, sourceId?: string): Promise<XIngest>;
}

type RawBroadcast = {
  id?: string;
  state?: string;
  title?: string;
  total_watching?: string;
  start_ms?: string;
  created_at_ms?: string;
  source_id?: string;
};

/** Maps X broadcast states (docs.x.com/livestream-api/broadcasts/overview); unknown states count as terminal. */
export function mapBroadcastState(state: string | undefined): XBroadcast['broadcast'] {
  switch (state) {
    case 'RUNNING':
      return 'running';
    case 'NOT_STARTED':
    case 'PRE_PUBLISHED':
      return 'scheduled';
    default:
      return 'ended';
  }
}

const toInt = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function pickBroadcast(list: RawBroadcast[]): XBroadcast | null {
  if (list.length === 0) return null;
  const newest = [...list].sort(
    (a, b) => (toInt(b.created_at_ms) ?? 0) - (toInt(a.created_at_ms) ?? 0),
  );
  const raw = newest.find((b) => b.state === 'RUNNING') ?? newest[0]!;
  const viewers = toInt(raw.total_watching);
  const startedAt = toInt(raw.start_ms);
  return {
    broadcast: mapBroadcastState(raw.state),
    ...(raw.title ? { title: raw.title } : {}),
    ...(viewers !== undefined ? { viewers } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(raw.source_id ? { sourceId: raw.source_id } : {}),
  };
}

type RawSource = { id?: string; is_stream_active?: boolean };

export function ingestFromSources(sources: RawSource[], sourceId?: string): XIngest {
  const relevant = sourceId ? sources.filter((s) => s.id === sourceId) : sources;
  if (relevant.length === 0) return 'unknown';
  if (relevant.some((s) => s.is_stream_active === true)) return 'active';
  return 'inactive';
}

export function createXApi(fetchFn: typeof fetch = fetch, now: () => number = Date.now): XApi {
  async function get(token: string, path: string, label: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new XApiError(`X ${label} request failed (network error)`, 'other');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      const retryAfterMs =
        Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now()) : undefined;
      throw new XApiError(`X rate limit reached (${label})`, 'rate', retryAfterMs, 429);
    }
    if (res.status === 401)
      throw new XApiError(`X rejected the sign-in (${label})`, 'auth', undefined, 401);
    if (res.status === 403) {
      throw new XApiError(
        `X does not allow this app to read ${label}`,
        'forbidden',
        undefined,
        403,
      );
    }
    throw new XApiError(
      `X ${label} request failed (${res.status})`,
      'other',
      undefined,
      res.status,
    );
  }

  return {
    async me(token) {
      const body = await get(token, '/users/me', 'your account');
      const data = body.data as { id?: string; username?: string } | undefined;
      if (!data?.id || !data.username) throw new XApiError('X returned no account', 'other');
      return { id: data.id, username: data.username };
    },

    async latestBroadcast(token) {
      const query = new URLSearchParams({
        max_results: String(MAX_BROADCASTS),
        'broadcast.fields': BROADCAST_FIELDS,
      });
      const body = await get(token, `/broadcasts?${query}`, 'broadcasts');
      return pickBroadcast(Array.isArray(body.data) ? (body.data as RawBroadcast[]) : []);
    },

    async ingest(token, userId, sourceId) {
      let body: Record<string, unknown>;
      try {
        body = await get(token, `/users/${encodeURIComponent(userId)}/sources`, 'stream sources');
      } catch (err) {
        // The sources endpoint is allowlist-only; X answers 400/401/403/404 to apps without access.
        if (err instanceof XApiError && [400, 401, 403, 404].includes(err.status ?? 0)) {
          throw new XApiError('X does not share stream source status with this app', 'unavailable');
        }
        throw err;
      }
      // Source objects carry the RTMP stream key: read only the two fields we need and keep nothing else.
      const list = Array.isArray(body.sources)
        ? body.sources
        : Array.isArray(body.data)
          ? body.data
          : [];
      return ingestFromSources(
        (list as RawSource[]).map((s) => ({ id: s?.id, is_stream_active: s?.is_stream_active })),
        sourceId,
      );
    },
  };
}
