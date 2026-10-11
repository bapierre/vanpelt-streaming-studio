import { createHash, randomBytes } from 'node:crypto';
import type { SecretsStore } from '../../secrets/store';

const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_SCOPE = 'broadcast.read tweet.read users.read offline.access';
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60_000;
const SETUP = 'Add your X app client ID first (see docs/setup/x.md).';
const RECONNECT = 'X sign-in expired. Reconnect X in Settings → Platforms.';
const NOT_CONNECTED = 'X is not connected. Connect it in Settings → Platforms.';

export class XAuthError extends Error {}

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

/** OAuth 2.0 + PKCE with the streamer's own public ("Native App") client. See docs/connectors/x.md "Auth". */
export class XAuth {
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
    return Boolean(this.opts.store.get().x?.clientId);
  }

  connected(): boolean {
    return Boolean(this.opts.store.get().x?.refreshToken);
  }

  /** `@username`, once known. */
  account(): string | undefined {
    const username = this.opts.store.get().x?.username;
    return username ? `@${username}` : undefined;
  }

  userId(): string | undefined {
    return this.opts.store.get().x?.userId;
  }

  /** Saving a new client drops any tokens issued to the previous one. */
  async setClient(clientId: string): Promise<void> {
    this.generation++;
    this.pending = null;
    await this.opts.store.update((s) => ({ ...s, x: { clientId: clientId.trim() } }));
  }

  async setAccount(user: { id: string; username: string } | undefined): Promise<void> {
    await this.opts.store.update((s) =>
      s.x ? { ...s, x: { ...s.x, userId: user?.id, username: user?.username } } : s,
    );
  }

  beginAuth(): string {
    const x = this.opts.store.get().x;
    if (!x?.clientId) throw new XAuthError(SETUP);
    const verifier = this.random(48).toString('base64url');
    const state = this.random(16).toString('base64url');
    this.pending = { state, verifier, expiresAt: this.now() + SIGN_IN_WINDOW_MS };
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: x.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: X_SCOPE,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async completeAuth(query: { code?: string; state?: string; error?: string }): Promise<void> {
    const pending = this.pending;
    // State first: a forged redirect must not cancel a real sign-in or feed its error text through.
    if (!pending || query.state !== pending.state || this.now() > pending.expiresAt) {
      throw new XAuthError('This sign-in link is invalid or expired. Start again from Settings → Platforms.');
    }
    if (query.error) {
      this.pending = null;
      throw new XAuthError(`X sign-in failed: ${query.error}`);
    }
    if (!query.code) {
      throw new XAuthError('This sign-in link is invalid or expired. Start again from Settings → Platforms.');
    }
    this.pending = null;
    const generation = this.generation;
    const x = this.opts.store.get().x;
    if (!x) throw new XAuthError(SETUP);
    // X auth codes expire after about 30 seconds, so this exchange runs straight from the callback.
    const body = await this.token({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: this.opts.redirectUri,
      code_verifier: pending.verifier,
      client_id: x.clientId,
    });
    if (!body.refresh_token) {
      throw new XAuthError(
        'X did not return a refresh token. Connect again from Settings → Platforms.',
      );
    }
    let written = false;
    await this.opts.store.update((s) => {
      if (generation !== this.generation || !s.x || s.x.clientId !== x.clientId) return s;
      written = true;
      return {
        ...s,
        x: {
          clientId: s.x.clientId,
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          expiresAt: this.now() + clampSeconds(body.expires_in) * 1000,
        },
      };
    });
    if (!written) throw new XAuthError('X was disconnected during sign-in. Connect again.');
    this.stale = false;
  }

  async accessToken(): Promise<string> {
    const x = this.opts.store.get().x;
    if (!x?.refreshToken) throw new XAuthError(NOT_CONNECTED);
    if (
      !this.stale &&
      x.accessToken &&
      x.expiresAt &&
      x.expiresAt - EXPIRY_MARGIN_MS > this.now()
    ) {
      return x.accessToken;
    }
    // X rotates refresh tokens, so two concurrent refreshes would invalidate each other.
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
    await this.opts.store.update((s) => (s.x ? { ...s, x: { clientId: s.x.clientId } } : s));
  }

  private async refresh(): Promise<string> {
    const x = this.opts.store.get().x;
    if (!x?.refreshToken) throw new XAuthError(NOT_CONNECTED);
    const generation = this.generation;
    let body: TokenResponse;
    try {
      body = await this.token({
        grant_type: 'refresh_token',
        refresh_token: x.refreshToken,
        client_id: x.clientId,
      });
    } catch (err) {
      if (err instanceof XAuthError) {
        await this.opts.store.update((s) =>
          generation === this.generation && s.x && s.x.refreshToken === x.refreshToken
            ? { ...s, x: { clientId: s.x.clientId } }
            : s,
        );
        throw new XAuthError(RECONNECT);
      }
      throw err;
    }
    let written = false;
    await this.opts.store.update((s) => {
      if (
        generation !== this.generation ||
        !s.x ||
        s.x.clientId !== x.clientId ||
        s.x.refreshToken !== x.refreshToken
      ) {
        return s;
      }
      written = true;
      return {
        ...s,
        x: {
          ...s.x,
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? s.x.refreshToken,
          expiresAt: this.now() + clampSeconds(body.expires_in) * 1000,
        },
      };
    });
    if (!written) throw new XAuthError('X was disconnected.');
    this.stale = false;
    return body.access_token;
  }

  /**
   * Only 400/401 are definitive (invalid_request, unauthorized_client, ...) and throw XAuthError.
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
      throw new Error('X token service unavailable (network error)');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body as unknown as TokenResponse;
    if (res.status === 400 || res.status === 401) {
      throw new XAuthError(`X token request failed: ${String(body.error ?? res.status)}`);
    }
    throw new Error(`X token service unavailable (${res.status})`);
  }
}
