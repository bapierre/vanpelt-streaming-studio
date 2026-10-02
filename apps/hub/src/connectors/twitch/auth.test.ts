import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretsStore } from '../../secrets/store';
import { fakeFetch, json } from '../../testing/http';
import { TwitchAuth, TwitchAuthError, type DeviceCode } from './auth';

let store: SecretsStore;
beforeEach(async () => {
  store = new SecretsStore(join(await mkdtemp(join(tmpdir(), 'twitch-auth-')), 'secrets.json'));
});

const validateOk = () => json(200, { client_id: 'cid', login: 'yatf', scopes: ['user:read:chat'], user_id: '42', expires_in: 14000 });
const code: DeviceCode = { deviceCode: 'dev', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate', intervalMs: 5000, expiresAt: 1_000_000 };
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

describe('TwitchAuth device flow', () => {
  it('starts the flow with the public client id and scope', async () => {
    const fetchFn = fakeFetch(() =>
      json(200, { device_code: 'dev', expires_in: 1800, interval: 5, user_code: 'ABCDEFGH', verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' }),
    );
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, now: () => 1000 });
    expect(await auth.startDeviceFlow()).toEqual({
      deviceCode: 'dev',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
      intervalMs: 5000,
      expiresAt: 1000 + 1_800_000,
    });
    expect(fetchFn.calls[0]!.url).toBe('https://id.twitch.tv/oauth2/device');
    expect(Object.fromEntries(fetchFn.calls[0]!.form)).toEqual({ client_id: 'cid', scopes: 'user:read:chat' });
  });

  it('polls until approved, then stores tokens with the validated identity', async () => {
    let polls = 0;
    const fetchFn = fakeFetch(({ url }) => {
      if (url.endsWith('/validate')) return validateOk();
      polls++;
      return polls < 3
        ? json(400, { status: 400, message: 'authorization_pending' })
        : json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 14000, scope: ['user:read:chat'], token_type: 'bearer' });
    });
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep, now: () => 0 });
    const tokens = await auth.pollDeviceFlow(code);
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', userId: '42', login: 'yatf' });
    expect(store.get().twitch).toEqual(tokens);
    expect(sleeps.slice(-3)).toEqual([5000, 5000, 5000]);
    const tokenCall = fetchFn.calls.find((c) => c.url.endsWith('/token'))!;
    expect(tokenCall.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(tokenCall.form.get('device_code')).toBe('dev');
  });

  it('stops on any other error', async () => {
    const fetchFn = fakeFetch(() => json(400, { status: 400, message: 'invalid device code' }));
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep, now: () => 0 });
    await expect(auth.pollDeviceFlow(code)).rejects.toThrow('invalid device code');
  });

  it('gives up when the code expires', async () => {
    const fetchFn = fakeFetch(() => json(400, { status: 400, message: 'authorization_pending' }));
    let t = 0;
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep: async () => void (t += 600_000), now: () => t });
    await expect(auth.pollDeviceFlow(code)).rejects.toThrow('expired');
  });

  it('can be cancelled', async () => {
    const fetchFn = fakeFetch(() => json(400, { status: 400, message: 'authorization_pending' }));
    const abort = new AbortController();
    abort.abort();
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn, sleep, now: () => 0 });
    await expect(auth.pollDeviceFlow(code, abort.signal)).rejects.toBeInstanceOf(TwitchAuthError);
  });
});

describe('TwitchAuth tokens', () => {
  const seed = () => store.update((s) => ({ ...s, twitch: { accessToken: 'old', refreshToken: 'r1', userId: '42', login: 'yatf' } }));

  it('refreshes once on 401 and retries Helix with the new token', async () => {
    await seed();
    const fetchFn = fakeFetch(({ url, init }) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'new', refresh_token: 'r2' });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(202, { data: [] }) : json(401, {});
    });
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn });
    const res = await auth.helix('/eventsub/subscriptions', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(store.get().twitch).toMatchObject({ accessToken: 'new', refreshToken: 'r2' });
    const refresh = fetchFn.calls.find((c) => c.url.endsWith('/token'))!;
    expect(Object.fromEntries(refresh.form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid' });
    const helixCall = fetchFn.calls.find((c) => c.url.includes('/helix/'))!;
    expect((helixCall.init.headers as Record<string, string>)['Client-Id']).toBe('cid');
  });

  it('refreshes only once for concurrent 401s (one-time refresh tokens)', async () => {
    await seed();
    const fetchFn = fakeFetch(({ url, init }) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'new', refresh_token: 'r2' });
      return (init.headers as Record<string, string>).Authorization === 'Bearer new' ? json(200, {}) : json(401, {});
    });
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn });
    await Promise.all([auth.helix('/a'), auth.helix('/b')]);
    expect(fetchFn.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it('validate is false when the token is dead and refresh fails', async () => {
    await seed();
    const fetchFn = fakeFetch(({ url }) =>
      url.endsWith('/validate') ? json(401, { status: 401, message: 'invalid access token' }) : json(400, { status: 400, message: 'Invalid refresh token' }),
    );
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn });
    expect(await auth.validate()).toBe(false);
  });

  it('validate is true for a live token', async () => {
    await seed();
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn: fakeFetch(() => validateOk()) });
    expect(await auth.validate()).toBe(true);
  });

  it('clear removes the Twitch tokens only', async () => {
    await seed();
    await store.update((s) => ({ ...s, youtube: { clientId: 'c', clientSecret: 's' } }));
    const auth = new TwitchAuth({ clientId: 'cid', store, fetchFn: fakeFetch(() => validateOk()) });
    await auth.clear();
    expect(store.get()).toEqual({ youtube: { clientId: 'c', clientSecret: 's' } });
  });
});
