import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../testing/http';
import { createXApi, mapBroadcastState, pickBroadcast, XApiError } from './api';

describe('mapBroadcastState', () => {
  it.each([
    ['RUNNING', 'running'],
    ['NOT_STARTED', 'scheduled'],
    ['PRE_PUBLISHED', 'scheduled'],
    ['ENDED', 'ended'],
    ['TIMED_OUT', 'ended'],
    ['CANCELED', 'ended'],
    ['SOMETHING_NEW', 'ended'],
    [undefined, 'ended'],
  ])('%s -> %s', (state, expected) => {
    expect(mapBroadcastState(state)).toBe(expected);
  });
});

describe('pickBroadcast', () => {
  it('returns null for no broadcasts', () => {
    expect(pickBroadcast([])).toBeNull();
  });

  it('prefers a running broadcast and parses string numbers', () => {
    expect(
      pickBroadcast([
        { id: 'new', state: 'ENDED', created_at_ms: '3000' },
        {
          id: 'live',
          state: 'RUNNING',
          created_at_ms: '2000',
          title: 'Show',
          total_watching: '17',
          start_ms: '2500',
          source_id: 'src1',
        },
      ]),
    ).toEqual({
      broadcast: 'running',
      title: 'Show',
      viewers: 17,
      startedAt: 2500,
      sourceId: 'src1',
    });
  });

  it('otherwise takes the newest broadcast and omits unparseable viewers', () => {
    expect(
      pickBroadcast([
        { state: 'ENDED', created_at_ms: '1000' },
        { state: 'NOT_STARTED', created_at_ms: '5000', total_watching: 'n/a' },
      ]),
    ).toEqual({ broadcast: 'scheduled' });
  });
});

describe('createXApi', () => {
  it('lists broadcasts with field selection and a bearer token', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { data: [{ state: 'RUNNING', total_watching: '3' }], meta: {} }),
    );
    const api = createXApi(fetchFn);
    expect(await api.latestBroadcast('TOK')).toEqual({ broadcast: 'running', viewers: 3 });
    const url = new URL(fetchFn.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.x.com/2/broadcasts');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.searchParams.get('broadcast.fields')).toBe(
      'id,state,title,total_watching,start_ms,created_at_ms,source_id',
    );
    expect(fetchFn.calls[0]!.init.headers).toEqual({ Authorization: 'Bearer TOK' });
  });

  it('returns null when the account has no broadcasts', async () => {
    expect(
      await createXApi(fakeFetch(() => json(200, { meta: { result_count: 0 } }))).latestBroadcast(
        't',
      ),
    ).toBeNull();
  });

  it('reads the account from /2/users/me', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { data: { id: '42', name: 'YATF', username: 'yatf' } }),
    );
    expect(await createXApi(fetchFn).me('t')).toEqual({ id: '42', username: 'yatf' });
    expect(fetchFn.calls[0]!.url).toBe('https://api.x.com/2/users/me');
  });

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [500, 'other'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const err = await createXApi(fakeFetch(() => json(status, {})))
      .latestBroadcast('t')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).kind).toBe(kind);
  });

  it('maps 429 to rate with the delay from x-rate-limit-reset', async () => {
    const fetchFn = fakeFetch(
      () => new Response('{}', { status: 429, headers: { 'x-rate-limit-reset': '1100' } }),
    );
    const err = (await createXApi(fetchFn, () => 1_000_000)
      .latestBroadcast('t')
      .catch((e: unknown) => e)) as XApiError;
    expect(err.kind).toBe('rate');
    expect(err.retryAfterMs).toBe(100_000);
  });

  it('maps a network failure to other', async () => {
    const fetchFn = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = (await createXApi(fetchFn)
      .latestBroadcast('t')
      .catch((e: unknown) => e)) as XApiError;
    expect(err.kind).toBe('other');
  });

  describe('ingest', () => {
    it('reads is_stream_active for the broadcast source without keeping stream keys', async () => {
      const fetchFn = fakeFetch(() =>
        json(200, {
          sources: [
            { id: 'a', rtmp_stream_key: 'a', is_stream_active: false },
            { id: 'b', rtmp_stream_key: 'b', is_stream_active: true },
          ],
        }),
      );
      const api = createXApi(fetchFn);
      expect(await api.ingest('t', '42', 'a')).toBe('inactive');
      expect(await api.ingest('t', '42', 'b')).toBe('active');
      expect(await api.ingest('t', '42')).toBe('active');
      expect(await api.ingest('t', '42', 'missing')).toBe('unknown');
      expect(fetchFn.calls[0]!.url).toBe('https://api.x.com/2/users/42/sources');
    });

    it('reports unknown for an account with no sources', async () => {
      expect(await createXApi(fakeFetch(() => json(200, { sources: [] }))).ingest('t', '42')).toBe(
        'unknown',
      );
    });

    it.each([400, 401, 403, 404])(
      'throws unavailable on HTTP %i (allowlist-only endpoint)',
      async (status) => {
        const err = (await createXApi(fakeFetch(() => json(status, {})))
          .ingest('t', '42')
          .catch((e: unknown) => e)) as XApiError;
        expect(err).toBeInstanceOf(XApiError);
        expect(err.kind).toBe('unavailable');
      },
    );
  });
});
