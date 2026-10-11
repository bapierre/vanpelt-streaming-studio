import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { runtimePaths } from '../../runtime';
import { fromGrpcResponse, type YtListResponse } from './normalize';

const API = 'https://www.googleapis.com/youtube/v3';
const GRPC_HOST = 'youtube.googleapis.com:443';
const PROTO_PATH = runtimePaths().proto;

/** `chatDisabled`: the broadcast is live but its chat is turned off. */
export type YouTubeApiErrorKind = 'auth' | 'ended' | 'chatDisabled' | 'rate' | 'other';

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly kind: YouTubeApiErrorKind,
  ) {
    super(message);
  }
}

export type StreamHandlers = {
  onResponse(r: YtListResponse): void;
  onError(err: YouTubeApiError): void;
  onEnd(): void;
};

export type ChatStream = { cancel(): void };

export interface YouTubeApi {
  findActiveChat(token: string): Promise<{ liveChatId: string; title: string } | null>;
  myChannelTitle(token: string): Promise<string | undefined>;
  /** YouTube rounds subscriber counts down to three significant figures; hidden counts come back undefined. */
  channelStats?(token: string): Promise<{ subscribers?: number }>;
  pollChat(token: string, liveChatId: string, pageToken?: string): Promise<YtListResponse>;
  streamChat(token: string, liveChatId: string, pageToken: string | undefined, handlers: StreamHandlers): ChatStream;
}

const RATE_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'userRateLimitExceeded']);
const ENDED_REASONS = new Set(['liveChatEnded', 'liveChatNotFound']);
const CHAT_DISABLED = /liveChatDisabled|chat is disabled/i;

async function restError(res: Response): Promise<YouTubeApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: Array<{ reason?: string }> };
  };
  const reason = body.error?.errors?.[0]?.reason ?? '';
  const message = `YouTube API ${res.status}${reason ? ` (${reason})` : ''}`;
  if (res.status === 401) return new YouTubeApiError(message, 'auth');
  if (RATE_REASONS.has(reason)) return new YouTubeApiError('YouTube quota or rate limit reached', 'rate');
  if (reason === 'liveChatDisabled') return new YouTubeApiError(message, 'chatDisabled');
  if (ENDED_REASONS.has(reason) || res.status === 404) return new YouTubeApiError(message, 'ended');
  return new YouTubeApiError(message, 'other');
}

export function mapGrpcError(err: { code?: number; details?: string; message?: string }): YouTubeApiError {
  const message = `YouTube stream: ${err.details || err.message || `gRPC status ${err.code}`}`;
  switch (err.code) {
    case grpc.status.UNAUTHENTICATED:
      return new YouTubeApiError(message, 'auth');
    case grpc.status.FAILED_PRECONDITION:
    case grpc.status.NOT_FOUND:
      return new YouTubeApiError(message, CHAT_DISABLED.test(message) ? 'chatDisabled' : 'ended');
    case grpc.status.RESOURCE_EXHAUSTED:
      return new YouTubeApiError('YouTube quota or rate limit reached', 'rate');
    default:
      return new YouTubeApiError(message, 'other');
  }
}

let serviceCtor: grpc.ServiceClientConstructor | null = null;

export function loadStreamListService(): grpc.ServiceClientConstructor {
  if (!serviceCtor) {
    const definition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: false,
      oneofs: false,
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      youtube: { api: { v3: { V3DataLiveChatMessageService: grpc.ServiceClientConstructor } } };
    };
    serviceCtor = pkg.youtube.api.v3.V3DataLiveChatMessageService;
  }
  return serviceCtor;
}

type StreamListClient = grpc.Client & {
  StreamList(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<YtListResponse>;
};

export function createYouTubeApi(fetchFn: typeof fetch = fetch): YouTubeApi {
  const get = async (path: string, params: Record<string, string>, token: string) => {
    const url = new URL(`${API}${path}`);
    url.search = new URLSearchParams(params).toString();
    const res = await fetchFn(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await restError(res);
    return res.json() as Promise<Record<string, unknown>>;
  };

  return {
    async findActiveChat(token) {
      const body = (await get('/liveBroadcasts', { part: 'snippet', broadcastStatus: 'active', broadcastType: 'all' }, token)) as {
        items?: Array<{ snippet?: { title?: string; liveChatId?: string } }>;
      };
      const live = body.items?.find((b) => b.snippet?.liveChatId);
      return live ? { liveChatId: live.snippet!.liveChatId!, title: live.snippet!.title ?? 'YouTube live' } : null;
    },

    async myChannelTitle(token) {
      const body = (await get('/channels', { part: 'snippet', mine: 'true' }, token)) as {
        items?: Array<{ snippet?: { title?: string } }>;
      };
      return body.items?.[0]?.snippet?.title;
    },

    async channelStats(token) {
      const body = (await get('/channels', { part: 'statistics', mine: 'true' }, token)) as {
        items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }>;
      };
      const stats = body.items?.[0]?.statistics;
      const n = Number(stats?.subscriberCount);
      return stats && !stats.hiddenSubscriberCount && Number.isInteger(n) && n >= 0 ? { subscribers: n } : {};
    },

    async pollChat(token, liveChatId, pageToken) {
      const params: Record<string, string> = { liveChatId, part: 'snippet,authorDetails' };
      if (pageToken) params.pageToken = pageToken;
      return (await get('/liveChat/messages', params, token)) as YtListResponse;
    },

    streamChat(token, liveChatId, pageToken, handlers) {
      const Service = loadStreamListService();
      const client = new Service(GRPC_HOST, grpc.credentials.createSsl()) as unknown as StreamListClient;
      const metadata = new grpc.Metadata();
      metadata.set('authorization', `Bearer ${token}`);
      const request: Record<string, unknown> = { liveChatId, part: ['snippet', 'authorDetails'], profileImageSize: 88 };
      if (pageToken) request.pageToken = pageToken;
      let cancelled = false;
      const call = client.StreamList(request, metadata);
      // Listeners are attached synchronously, 'error' first, so nothing can emit unhandled.
      call.on('error', (err: grpc.ServiceError) => {
        if (!cancelled) handlers.onError(mapGrpcError(err));
      });
      call.on('data', (r: YtListResponse) => {
        let normalized: YtListResponse;
        try {
          normalized = fromGrpcResponse(r);
        } catch (err) {
          if (!cancelled) {
            handlers.onError(new YouTubeApiError(`YouTube stream: malformed response (${(err as Error).message})`, 'other'));
          }
          return;
        }
        if (!cancelled) handlers.onResponse(normalized);
      });
      call.on('end', () => {
        if (!cancelled) handlers.onEnd();
      });
      return {
        cancel() {
          cancelled = true;
          call.cancel();
          client.close();
        },
      };
    },
  };
}
