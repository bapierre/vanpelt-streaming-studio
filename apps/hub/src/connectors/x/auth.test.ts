import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from '../../secrets/store';
import { fakeFetch, json } from '../../testing/http';
import { XAuth, XAuthError } from './auth';

const REDIRECT = 'http://127.0.0.1:4747/oauth/x/callback';
let store: SecretsStore;
let t: number;
beforeEach(async () => {
  store = new SecretsStore(join(await mkdtemp(join(tmpdir(), 'x-auth-')), 'secrets.json'));
  t = 1_000_000;
});

const make = (fetchFn = fakeFetch(() => json(500, {}))) =>
  new XAuth({
    store,
    redirectUri: REDIRECT,
    fetchFn,
    now: () => t,
    random: (n) => Buffer.alloc(n, 7),
  });

const signIn = async (auth: XAuth) => new URL(auth.beginAuth()).searchParams.get('state')!;

describe('XAuth', () => {
  it('requires a client id before sign-in', () => {
    expect(() => make().beginAuth()).toThrow(XAuthError);
    expect(() => make().beginAuth()).toThrow('docs/setup/x.md');
  });

  it('stores a trimmed client id and builds a PKCE S256 sign-in url', async () => {
    const auth = make();
    await auth.setClient('  cid  ');
    expect(auth.clientConfigured()).toBe(true);
    expect(store.get().x).toEqual({ clientId: 'cid' });
    const url = new URL(auth.beginAuth());
    const verifier = Buffer.alloc(48, 7).toString('base64url');
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: REDIRECT,
      scope: 'broadcast.read tweet.read users.read offline.access',
      state: Buffer.alloc(16, 7).toString('base64url'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
  });

  it('rejects a callback with the wrong state or after the sign-in window', async () => {
    const auth = make();
    await auth.setClient('cid');
    const state = await signIn(auth);
    await expect(auth.completeAuth({ code: 'c', state: 'forged' })).rejects.toThrow(
      'invalid or expired',
    );
    t += 11 * 60 * 1000;
    await expect(auth.completeAuth({ code: 'c', state })).rejects.toThrow('invalid or expired');
  });

  it('reports an X error from the callback', async () => {
    const auth = make();
    await auth.setClient('cid');
    await signIn(auth);
    await expect(auth.completeAuth({ error: 'access_denied' })).rejects.toThrow(
      'X sign-in failed: access_denied',
    );
  });

  it('exchanges the code as a public client (client_id in the body, no Basic auth)', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 7200 }),
    );
    const auth = make(fetchFn);
    await auth.setClient('cid');
    const state = await signIn(auth);
    await auth.completeAuth({ code: 'the-code', state });
    const call = fetchFn.calls[0]!;
    expect(call.url).toBe('https://api.x.com/2/oauth2/token');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(call.form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT,
      code_verifier: Buffer.alloc(48, 7).toString('base64url'),
      client_id: 'cid',
    });
    expect(store.get().x).toEqual({
      clientId: 'cid',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: t + 7_200_000,
    });
    expect(auth.connected()).toBe(true);
    await expect(auth.completeAuth({ code: 'again', state })).rejects.toThrow('invalid or expired');
  });

  it('labels the account with @username and keeps the user id', async () => {
    const auth = make();
    await store.update((s) => ({ ...s, x: { clientId: 'cid', refreshToken: 'rt' } }));
    await auth.setAccount({ id: '42', username: 'yatf' });
    expect(auth.account()).toBe('@yatf');
    expect(auth.userId()).toBe('42');
  });

  it('refreshes near expiry and stores the rotated refresh token', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { access_token: 'fresh', refresh_token: 'rt2', expires_in: 7200 }),
    );
    const auth = make(fetchFn);
    await store.update((s) => ({
      ...s,
      x: {
        clientId: 'cid',
        accessToken: 'cached',
        refreshToken: 'rt1',
        expiresAt: t + 30_000,
        username: 'yatf',
      },
    }));
    expect(await auth.accessToken()).toBe('fresh');
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt1',
      client_id: 'cid',
    });
    expect(store.get().x).toEqual({
      clientId: 'cid',
      accessToken: 'fresh',
      refreshToken: 'rt2',
      expiresAt: t + 7_200_000,
      username: 'yatf',
    });
    expect(await auth.accessToken()).toBe('fresh');
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('runs one refresh for concurrent callers (refresh tokens rotate)', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { access_token: 'fresh', refresh_token: 'rt2', expires_in: 7200 }),
    );
    const auth = make(fetchFn);
    await store.update((s) => ({ ...s, x: { clientId: 'cid', refreshToken: 'rt1' } }));
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['fresh', 'fresh']);
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('refreshes after invalidate', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { access_token: 'fresh', refresh_token: 'rt2', expires_in: 7200 }),
    );
    const auth = make(fetchFn);
    await store.update((s) => ({
      ...s,
      x: { clientId: 'cid', accessToken: 'cached', refreshToken: 'rt1', expiresAt: t + 3_600_000 },
    }));
    expect(await auth.accessToken()).toBe('cached');
    auth.invalidate();
    expect(await auth.accessToken()).toBe('fresh');
  });

  it('clears tokens and asks to reconnect when X rejects the refresh token', async () => {
    const auth = make(
      fakeFetch(() =>
        json(400, {
          error: 'invalid_request',
          error_description: 'Value passed for the token was invalid.',
        }),
      ),
    );
    await store.update((s) => ({
      ...s,
      x: { clientId: 'cid', refreshToken: 'RTVAL', username: 'yatf' },
    }));
    const err = await auth.accessToken().catch((e: Error) => e);
    expect(err).toBeInstanceOf(XAuthError);
    expect((err as Error).message).toBe('X sign-in expired. Reconnect X in Settings → Platforms.');
    expect(store.get().x).toEqual({ clientId: 'cid' });
  });

  it.each([
    ['a 503', () => json(503, {})],
    ['a 429', () => json(429, {})],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('treats %s during refresh as temporary and keeps the tokens', async (_label, respond) => {
    const auth = make(fakeFetch(respond));
    const x = { clientId: 'cid', refreshToken: 'rt' };
    await store.update((s) => ({ ...s, x }));
    const err = await auth.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(XAuthError);
    expect(store.get().x).toEqual(x);
  });

  it('setClient drops tokens and invalidates a sign-in in progress', async () => {
    const auth = make();
    await auth.setClient('cid');
    const state = await signIn(auth);
    await store.update((s) => ({ ...s, x: { ...s.x!, refreshToken: 'rt', username: 'yatf' } }));
    await auth.setClient('other');
    expect(store.get().x).toEqual({ clientId: 'other' });
    await expect(auth.completeAuth({ code: 'c', state })).rejects.toThrow('invalid or expired');
  });

  it('does not store tokens when disconnected during the code exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const auth = make(
      fakeFetch(async () => {
        await gate;
        return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 7200 });
      }),
    );
    await auth.setClient('cid');
    const state = await signIn(auth);
    const done = auth.completeAuth({ code: 'c', state });
    await auth.clearTokens();
    release();
    await expect(done).rejects.toThrow('disconnected during sign-in');
    expect(store.get().x).toEqual({ clientId: 'cid' });
  });

  it('does not bring tokens back when disconnected during a refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = fakeFetch(async () => {
      await gate;
      return json(200, { access_token: 'fresh', refresh_token: 'rt2', expires_in: 7200 });
    });
    const auth = make(fetchFn);
    await store.update((s) => ({ ...s, x: { clientId: 'cid', refreshToken: 'rt' } }));
    const pending = auth.accessToken();
    await vi.waitFor(() => expect(fetchFn.calls).toHaveLength(1));
    await auth.clearTokens();
    release();
    await expect(pending).rejects.toThrow('X was disconnected.');
    expect(store.get().x).toEqual({ clientId: 'cid' });
  });

  it('never puts tokens in error messages', async () => {
    const auth = make(
      fakeFetch(() => json(401, { error: 'unauthorized_client', refresh_token: 'LEAK' })),
    );
    await store.update((s) => ({ ...s, x: { clientId: 'cid', refreshToken: 'RTVAL' } }));
    const err = await auth.accessToken().catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/LEAK|RTVAL/);
  });
});
