import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../testing/http';
import { createYouTubeApi, loadStreamListService, mapGrpcError, YouTubeApiError } from './api';

const googleError = (status: number, reason: string) =>
  json(status, { error: { code: status, message: `reason ${reason}`, errors: [{ reason }] } });

describe('findActiveChat', () => {
  it('asks for the active broadcast of any type and returns its chat id', async () => {
    const fetchFn = fakeFetch(() => json(200, { items: [{ id: 'vid', snippet: { title: 'Show #1', liveChatId: 'CHAT' } }] }));
    const api = createYouTubeApi(fetchFn);
    expect(await api.findActiveChat('tok')).toEqual({ liveChatId: 'CHAT', title: 'Show #1' });
    const url = new URL(fetchFn.calls[0]!.url);
    expect(url.pathname).toBe('/youtube/v3/liveBroadcasts');
    expect(Object.fromEntries(url.searchParams)).toEqual({ part: 'snippet', broadcastStatus: 'active', broadcastType: 'all' });
    expect((fetchFn.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns null when nothing is live', async () => {
    expect(await createYouTubeApi(fakeFetch(() => json(200, { items: [] }))).findActiveChat('t')).toBeNull();
  });

  it('classifies an expired token as an auth error', async () => {
    const api = createYouTubeApi(fakeFetch(() => googleError(401, 'authError')));
    await expect(api.findActiveChat('t')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('classifies quota exhaustion as a rate error', async () => {
    const api = createYouTubeApi(fakeFetch(() => googleError(403, 'quotaExceeded')));
    await expect(api.findActiveChat('t')).rejects.toMatchObject({ kind: 'rate' });
  });
});

describe('pollChat', () => {
  it('requests snippet and authorDetails with the page token', async () => {
    const fetchFn = fakeFetch(() => json(200, { nextPageToken: 'n2', pollingIntervalMillis: 3000, items: [] }));
    const r = await createYouTubeApi(fetchFn).pollChat('t', 'CHAT', 'n1');
    expect(r).toMatchObject({ nextPageToken: 'n2', pollingIntervalMillis: 3000 });
    const url = new URL(fetchFn.calls[0]!.url);
    expect(url.pathname).toBe('/youtube/v3/liveChat/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ liveChatId: 'CHAT', part: 'snippet,authorDetails', pageToken: 'n1' });
  });

  it('classifies an ended chat', async () => {
    const api = createYouTubeApi(fakeFetch(() => googleError(403, 'liveChatEnded')));
    await expect(api.pollChat('t', 'CHAT')).rejects.toMatchObject({ kind: 'ended' });
  });
});

describe('myChannelTitle', () => {
  it('reads the authenticated channel title', async () => {
    const fetchFn = fakeFetch(() => json(200, { items: [{ snippet: { title: 'Your Average Tech Founder' } }] }));
    expect(await createYouTubeApi(fetchFn).myChannelTitle('t')).toBe('Your Average Tech Founder');
    expect(new URL(fetchFn.calls[0]!.url).searchParams.get('mine')).toBe('true');
  });
});

describe('gRPC', () => {
  it('loads the published streamList service definition', () => {
    const service = loadStreamListService();
    expect(service.service.StreamList!.path).toBe('/youtube.api.v3.V3DataLiveChatMessageService/StreamList');
    expect(service.service.StreamList!.responseStream).toBe(true);
  });

  it('maps gRPC status codes', () => {
    expect(mapGrpcError({ code: 16, details: 'bad token' }).kind).toBe('auth');
    expect(mapGrpcError({ code: 9, details: 'chat ended' }).kind).toBe('ended');
    expect(mapGrpcError({ code: 5 }).kind).toBe('ended');
    expect(mapGrpcError({ code: 8 }).kind).toBe('rate');
    expect(mapGrpcError({ code: 14, details: 'unavailable' })).toBeInstanceOf(YouTubeApiError);
    expect(mapGrpcError({ code: 14 }).kind).toBe('other');
  });
});
