import type { SecretsStore, TwitchSecrets } from '../../secrets/store';

const ID_URL = 'https://id.twitch.tv/oauth2';
const HELIX_URL = 'https://api.twitch.tv/helix';
/** Chat, plus follows (alerts) and the subscriber count (goals). Subs, cheers and raids arrive through chat. */
export const TWITCH_SCOPES = 'user:read:chat moderator:read:followers channel:read:subscriptions';

export class TwitchAuthError extends Error {}

/** Server-supplied seconds, kept sane: a hostile or buggy token endpoint must not set our timers. */
const clampSeconds = (n: number, max = 31_536_000) => Math.min(max, Math.max(1, Number.isFinite(n) ? n : 1));

/** Twitch definitively rejected the refresh token (HTTP 400/401): the user must reconnect. */
export class TwitchLoginRejectedError extends TwitchAuthError {}

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
};

type Options = {
  clientId: string;
  store: SecretsStore;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Device Code Grant Flow for a Public client (no secret). See docs/connectors/twitch.md §2. */
export class TwitchAuth {
  private refreshing: Promise<TwitchSecrets> | null = null;
  /** Bumped by clear(); in-flight sign-ins and refreshes started earlier must not write tokens back. */
  private generation = 0;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: Options) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  tokens(): TwitchSecrets | undefined {
    return this.opts.store.get().twitch;
  }

  async startDeviceFlow(): Promise<DeviceCode> {
    const res = await this.post('/device', { client_id: this.opts.clientId, scopes: TWITCH_SCOPES });
    if (!res.ok) throw new TwitchAuthError(`Twitch refused to start sign-in (${res.status})`);
    const b = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };
    return {
      deviceCode: b.device_code,
      userCode: b.user_code,
      verificationUri: b.verification_uri,
      intervalMs: clampSeconds(b.interval, 3600) * 1000,
      expiresAt: this.now() + clampSeconds(b.expires_in) * 1000,
    };
  }

  async pollDeviceFlow(code: DeviceCode, signal?: AbortSignal): Promise<TwitchSecrets> {
    const generation = this.generation;
    while (this.now() < code.expiresAt) {
      if (signal?.aborted) throw new TwitchAuthError('sign-in cancelled');
      await this.sleep(code.intervalMs);
      if (signal?.aborted) throw new TwitchAuthError('sign-in cancelled');
      const res = await this.post('/token', {
        client_id: this.opts.clientId,
        scopes: TWITCH_SCOPES,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return this.saveTokens(String(body.access_token), String(body.refresh_token), generation);
      if (body.message === 'authorization_pending') continue;
      throw new TwitchAuthError(`Twitch rejected the sign-in: ${String(body.message ?? res.status)}`);
    }
    throw new TwitchAuthError('The code expired before it was approved. Try again.');
  }

  /** Required by Twitch at startup and hourly. False means the user must reconnect. */
  async validate(): Promise<boolean> {
    const t = this.tokens();
    if (!t) return false;
    try {
      if (await this.whoAmI(t.accessToken)) return true;
      await this.refresh();
      return true;
    } catch (err) {
      // Only a definitive rejection means reconnect; network errors and 5xx are re-checked next hour.
      return !(err instanceof TwitchLoginRejectedError);
    }
  }

  refresh(): Promise<TwitchSecrets> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async helix(path: string, init: RequestInit = {}): Promise<Response> {
    const t = this.tokens();
    if (!t) throw new TwitchAuthError('Twitch is not connected');
    const send = (token: string) =>
      this.fetchFn(`${HELIX_URL}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
          'Client-Id': this.opts.clientId,
        },
      });
    const res = await send(t.accessToken);
    if (res.status !== 401) return res;
    const fresh = await this.refresh();
    return send(fresh.accessToken);
  }

  async clear(): Promise<void> {
    this.generation++;
    await this.opts.store.update((s) => {
      const rest = { ...s };
      delete rest.twitch;
      return rest;
    });
  }

  private async doRefresh(): Promise<TwitchSecrets> {
    const t = this.tokens();
    if (!t) throw new TwitchAuthError('Twitch is not connected');
    const generation = this.generation;
    const res = await this.post('/token', {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: this.opts.clientId,
    });
    if (res.status === 400 || res.status === 401) {
      throw new TwitchLoginRejectedError(`Twitch rejected the token refresh (${res.status})`);
    }
    if (!res.ok) throw new TwitchAuthError(`Twitch token refresh failed (${res.status})`);
    const b = (await res.json()) as { access_token: string; refresh_token: string };
    let next: TwitchSecrets | undefined;
    await this.opts.store.update((s) => {
      if (generation !== this.generation || !s.twitch) return s; // disconnected (or re-signed-in) while the refresh was in flight
      next = { ...s.twitch, accessToken: b.access_token, refreshToken: b.refresh_token };
      return { ...s, twitch: next };
    });
    if (!next) throw new TwitchAuthError('Twitch is not connected');
    return next;
  }

  private async saveTokens(accessToken: string, refreshToken: string, generation: number): Promise<TwitchSecrets> {
    const who = await this.whoAmI(accessToken);
    if (!who) throw new TwitchAuthError('Twitch returned a token that does not validate');
    const tokens = { accessToken, refreshToken, ...who };
    await this.opts.store.update((s) => {
      if (generation !== this.generation) throw new TwitchAuthError('sign-in cancelled');
      return { ...s, twitch: tokens };
    });
    return tokens;
  }

  private async whoAmI(token: string): Promise<{ userId: string; login: string } | null> {
    const res = await this.fetchFn(`${ID_URL}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (res.status === 401) return null;
    if (!res.ok) throw new TwitchAuthError(`Twitch token validation failed (${res.status})`);
    const b = (await res.json()) as { user_id: string; login: string };
    return { userId: b.user_id, login: b.login };
  }

  private post(path: string, form: Record<string, string>) {
    return this.fetchFn(`${ID_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }
}
