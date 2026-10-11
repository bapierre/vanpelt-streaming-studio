import { createHash, randomBytes } from 'node:crypto';
import type { SecretsStore } from '../../secrets/store';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60_000;
const RECONNECT = 'YouTube sign-in expired. Reconnect YouTube in Settings → Platforms.';

export class YouTubeAuthError extends Error {}

export interface TokenSource {
  accessToken(): Promise<string>;
  invalidate(): void;
}

type Options = {
  store: SecretsStore;
  redirectUri: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  random?: (bytes: number) => Buffer;
};

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string };

/** Server-supplied seconds, kept sane: a hostile or buggy token endpoint must not set our timers. */
const clampSeconds = (n: number, max = 31_536_000) => Math.min(max, Math.max(1, Number.isFinite(n) ? n : 1));

/** Loopback OAuth + PKCE with the streamer's own Desktop client. See docs/connectors/youtube.md "Auth". */
export class YouTubeAuth implements TokenSource {
  private pending: { state: string; verifier: string; expiresAt: number } | null = null;
  private stale = false;
  /** Bumped on disconnect or client change; token writes from earlier operations are refused. */
  private generation = 0;
  private refreshing: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;

  constructor(private readonly opts: Options) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? randomBytes;
  }

  clientConfigured(): boolean {
    return Boolean(this.opts.store.get().youtube?.clientId);
  }

  connected(): boolean {
    return Boolean(this.opts.store.get().youtube?.refreshToken);
  }

  account(): string | undefined {
    return this.opts.store.get().youtube?.channelTitle;
  }

  /** Saving a new client drops any tokens issued to the previous one. */
  async setClient(clientId: string, clientSecret: string): Promise<void> {
    this.generation++;
    this.pending = null;
    await this.opts.store.update((s) => ({
      ...s,
      youtube: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
    }));
  }

  async setAccount(channelTitle: string | undefined): Promise<void> {
    await this.opts.store.update((s) => (s.youtube ? { ...s, youtube: { ...s.youtube, channelTitle } } : s));
  }

  beginAuth(): string {
    const yt = this.opts.store.get().youtube;
    if (!yt?.clientId) throw new YouTubeAuthError('Add your Google OAuth client first (see docs/setup/youtube.md).');
    const verifier = this.random(48).toString('base64url');
    const state = this.random(16).toString('base64url');
    this.pending = { state, verifier, expiresAt: this.now() + SIGN_IN_WINDOW_MS };
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: yt.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    return url.toString();
  }

  async completeAuth(query: { code?: string; state?: string; error?: string }): Promise<void> {
    const pending = this.pending;
    // State first: a forged redirect must not cancel a real sign-in or feed its error text through.
    if (!pending || query.state !== pending.state || this.now() > pending.expiresAt) {
      throw new YouTubeAuthError('This sign-in link is invalid or expired. Start again from Settings → Platforms.');
    }
    if (query.error) {
      this.pending = null;
      throw new YouTubeAuthError(`Google sign-in failed: ${query.error}`);
    }
    if (!query.code) {
      throw new YouTubeAuthError('This sign-in link is invalid or expired. Start again from Settings → Platforms.');
    }
    this.pending = null;
    const generation = this.generation;
    const yt = this.opts.store.get().youtube;
    if (!yt) throw new YouTubeAuthError('Add your Google OAuth client first (see docs/setup/youtube.md).');
    const body = await this.token({
      grant_type: 'authorization_code',
      code: query.code,
      code_verifier: pending.verifier,
      redirect_uri: this.opts.redirectUri,
      client_id: yt.clientId,
      client_secret: yt.clientSecret,
    });
    if (!body.refresh_token) {
      throw new YouTubeAuthError(
        'Google did not return a refresh token. Remove streamhub at myaccount.google.com/permissions and connect again.',
      );
    }
    // Only write if the user has not disconnected, removed or replaced the client while the exchange was in flight.
    let written = false;
    await this.opts.store.update((s) => {
      if (
        generation !== this.generation ||
        !s.youtube ||
        s.youtube.clientId !== yt.clientId ||
        s.youtube.clientSecret !== yt.clientSecret
      ) {
        return s;
      }
      written = true;
      return {
        ...s,
        youtube: {
          ...s.youtube,
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          expiresAt: this.now() + clampSeconds(body.expires_in) * 1000,
        },
      };
    });
    if (!written) throw new YouTubeAuthError('YouTube was disconnected during sign-in. Connect again.');
    this.stale = false;
  }

  async accessToken(): Promise<string> {
    const yt = this.opts.store.get().youtube;
    if (!yt?.refreshToken) throw new YouTubeAuthError('YouTube is not connected. Connect it in Settings → Platforms.');
    if (!this.stale && yt.accessToken && yt.expiresAt && yt.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return yt.accessToken;
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  invalidate(): void {
    this.stale = true;
  }

  async clearTokens(): Promise<void> {
    this.generation++;
    this.pending = null;
    await this.opts.store.update((s) =>
      s.youtube ? { ...s, youtube: { clientId: s.youtube.clientId, clientSecret: s.youtube.clientSecret } } : s,
    );
  }

  private async refresh(): Promise<string> {
    const yt = this.opts.store.get().youtube;
    if (!yt?.refreshToken) throw new YouTubeAuthError('YouTube is not connected. Connect it in Settings → Platforms.');
    const generation = this.generation;
    let body: TokenResponse;
    try {
      body = await this.token({
        grant_type: 'refresh_token',
        refresh_token: yt.refreshToken,
        client_id: yt.clientId,
        client_secret: yt.clientSecret,
      });
    } catch (err) {
      if (err instanceof YouTubeAuthError && err.message.includes('invalid_grant')) {
        await this.opts.store.update((s) =>
          generation === this.generation && s.youtube && s.youtube.refreshToken === yt.refreshToken
            ? { ...s, youtube: { clientId: s.youtube.clientId, clientSecret: s.youtube.clientSecret } }
            : s,
        );
        throw new YouTubeAuthError(RECONNECT);
      }
      throw err;
    }
    // Skip the write if the user disconnected or changed the sign-in while the refresh was in flight.
    let written = false;
    await this.opts.store.update((s) => {
      if (
        generation !== this.generation ||
        !s.youtube ||
        s.youtube.clientId !== yt.clientId ||
        s.youtube.refreshToken !== yt.refreshToken
      ) {
        return s;
      }
      written = true;
      return {
        ...s,
        youtube: { ...s.youtube, accessToken: body.access_token, expiresAt: this.now() + clampSeconds(body.expires_in) * 1000 },
      };
    });
    if (!written) throw new YouTubeAuthError('YouTube was disconnected.');
    this.stale = false;
    return body.access_token;
  }

  /**
   * Only 400/401 are definitive (invalid_grant, invalid_client, ...) and throw YouTubeAuthError.
   * 5xx, 429 and network failures throw a plain Error so callers back off and retry.
   */
  private async token(form: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new Error('Google token service unavailable (network error)');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body as unknown as TokenResponse;
    if (res.status === 400 || res.status === 401) {
      throw new YouTubeAuthError(`Google token request failed: ${String(body.error ?? res.status)}`);
    }
    throw new Error(`Google token service unavailable (${res.status})`);
  }
}
