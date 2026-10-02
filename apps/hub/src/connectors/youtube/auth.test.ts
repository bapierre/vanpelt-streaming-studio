import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from '../../secrets/store';
import { fakeFetch, json } from '../../testing/http';
import { YouTubeAuth, YouTubeAuthError } from './auth';

const REDIRECT = 'http://127.0.0.1:4747/oauth/youtube/callback';
let store: SecretsStore;
let t: number;
beforeEach(async () => {
  store = new SecretsStore(join(await mkdtemp(join(tmpdir(), 'yt-auth-')), 'secrets.json'));
  t = 1_000_000;
});

const make = (fetchFn = fakeFetch(() => json(500, {}))) =>
  new YouTubeAuth({ store, redirectUri: REDIRECT, fetchFn, now: () => t, random: (n) => Buffer.alloc(n, 7) });

describe('YouTubeAuth', () => {
  it('requires a client before sign-in', () => {
    expect(() => make().beginAuth()).toThrow(YouTubeAuthError);
  });

  it('stores a trimmed client and builds a PKCE sign-in url', async () => {
    const auth = make();
    await auth.setClient('  cid.apps.googleusercontent.com ', ' secret ');
    expect(auth.clientConfigured()).toBe(true);
    expect(store.get().youtube).toEqual({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' });
    const url = new URL(auth.beginAuth());
    const verifier = Buffer.alloc(48, 7).toString('base64url');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid.apps.googleusercontent.com',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: Buffer.alloc(16, 7).toString('base64url'),
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('rejects a callback with the wrong state', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    auth.beginAuth();
    await expect(auth.completeAuth({ code: 'c', state: 'forged' })).rejects.toThrow('invalid or expired');
  });

  it('rejects a callback after the sign-in window', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    t += 11 * 60 * 1000;
    await expect(auth.completeAuth({ code: 'c', state })).rejects.toThrow('invalid or expired');
  });

  it('reports a Google error from the callback', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    auth.beginAuth();
    await expect(auth.completeAuth({ error: 'access_denied' })).rejects.toThrow('access_denied');
  });

  it('exchanges the code with the verifier and stores tokens', async () => {
    const fetchFn = fakeFetch(() => json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
    const auth = make(fetchFn);
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    await auth.completeAuth({ code: 'the-code', state });
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: Buffer.alloc(48, 7).toString('base64url'),
      redirect_uri: REDIRECT,
      client_id: 'cid',
      client_secret: 'secret',
    });
    expect(store.get().youtube).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: t + 3_600_000 });
    expect(auth.connected()).toBe(true);
    // A state can only be used once.
    await expect(auth.completeAuth({ code: 'again', state })).rejects.toThrow('invalid or expired');
  });

  it('uses the cached token, refreshes near expiry and after invalidate', async () => {
    const fetchFn = fakeFetch(() => json(200, { access_token: 'fresh', expires_in: 3600 }));
    const auth = make(fetchFn);
    await store.update((s) => ({ ...s, youtube: { clientId: 'cid', clientSecret: 's', accessToken: 'cached', refreshToken: 'rt', expiresAt: t + 600_000 } }));
    expect(await auth.accessToken()).toBe('cached');
    auth.invalidate();
    expect(await auth.accessToken()).toBe('fresh');
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'cid', client_secret: 's' });
    t += 3_600_000 - 30_000; // within 60 s of expiry
    await auth.accessToken();
    expect(fetchFn.calls).toHaveLength(2);
  });

  it('clears tokens and asks to reconnect when Google says invalid_grant', async () => {
    const auth = make(fakeFetch(() => json(400, { error: 'invalid_grant' })));
    await store.update((s) => ({ ...s, youtube: { clientId: 'cid', clientSecret: 's', refreshToken: 'rt' } }));
    await expect(auth.accessToken()).rejects.toThrow('Reconnect YouTube');
    expect(store.get().youtube).toEqual({ clientId: 'cid', clientSecret: 's' });
    expect(auth.connected()).toBe(false);
  });

  it('throws when not connected', async () => {
    await expect(make().accessToken()).rejects.toBeInstanceOf(YouTubeAuthError);
  });

  it('does not restore tokens when the client was removed during the code exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = fakeFetch(async () => {
      await gate;
      return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    });
    const auth = make(fetchFn);
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    const done = auth.completeAuth({ code: 'c', state });
    await store.update((s) => ({ ...s, youtube: undefined }));
    release();
    await expect(done).rejects.toThrow('disconnected during sign-in');
    expect(store.get().youtube).toBeUndefined();
  });

  it('does not write tokens issued to a client that was replaced during the code exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = fakeFetch(async () => {
      await gate;
      return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    });
    const auth = make(fetchFn);
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    const done = auth.completeAuth({ code: 'c', state });
    await auth.setClient('other', 'secret2');
    release();
    await expect(done).rejects.toThrow('disconnected during sign-in');
    expect(store.get().youtube).toEqual({ clientId: 'other', clientSecret: 'secret2' });
  });

  it('does not bring tokens back when disconnected during a refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = fakeFetch(async () => {
      await gate;
      return json(200, { access_token: 'fresh', expires_in: 3600 });
    });
    const auth = make(fetchFn);
    await store.update((s) => ({ ...s, youtube: { clientId: 'cid', clientSecret: 's', refreshToken: 'rt' } }));
    const pending = auth.accessToken();
    await vi.waitFor(() => expect(fetchFn.calls).toHaveLength(1));
    await auth.clearTokens();
    release();
    await expect(pending).rejects.toThrow('YouTube was disconnected.');
    expect(store.get().youtube).toEqual({ clientId: 'cid', clientSecret: 's' });
  });

  it('never puts tokens or secrets in error messages', async () => {
    const auth = make(fakeFetch(() => json(400, { error: 'invalid_request', refresh_token: 'LEAK' })));
    await store.update((s) => ({ ...s, youtube: { clientId: 'cid', clientSecret: 'SECRETVAL', refreshToken: 'RTVAL' } }));
    const err = await auth.accessToken().catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/LEAK|SECRETVAL|RTVAL/);
  });

  it('does not store tokens when disconnected (clearTokens) during the code exchange', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const auth = make(
      fakeFetch(async () => {
        await gate;
        return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      }),
    );
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    const done = auth.completeAuth({ code: 'c', state });
    await vi.waitFor(() => expect(store.get().youtube).toBeDefined());
    await auth.clearTokens();
    release();
    await expect(done).rejects.toThrow('disconnected');
    expect(store.get().youtube).toEqual({ clientId: 'cid', clientSecret: 'secret' });
    expect(auth.connected()).toBe(false);
  });

  it('rejects a sign-in started before a disconnect', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    await auth.clearTokens();
    await expect(auth.completeAuth({ code: 'c', state })).rejects.toThrow('invalid or expired');
  });

  it('rejects a sign-in started before the client was replaced', async () => {
    const auth = make();
    await auth.setClient('cid', 'secret');
    const state = new URL(auth.beginAuth()).searchParams.get('state')!;
    await auth.setClient('cid', 'secret');
    await expect(auth.completeAuth({ code: 'c', state })).rejects.toThrow('invalid or expired');
  });
});
