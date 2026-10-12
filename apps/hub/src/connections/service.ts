import type { ConnectionState, Envelope, EventPayload, Platform } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { TwitchAuth } from '../connectors/twitch/auth';
import type { YouTubeApi } from '../connectors/youtube/api';
import type { YouTubeAuth } from '../connectors/youtube/auth';
import type { XApi } from '../connectors/x/api';
import type { XAuth } from '../connectors/x/auth';
import { describeError } from '../util/errors';

const KICK_NOTE = 'Kick arrives with the relay (M3).';
const TWITCH_SETUP = 'Add your Twitch app client ID first (see docs/setup/twitch.md).';
const YOUTUBE_SETUP = 'Add your Google OAuth client first (see docs/setup/youtube.md).';
const X_SETUP = 'Add your X app client ID first (see docs/setup/x.md).';

/** Fastify's query parser yields arrays for repeated params; only plain strings are usable here. */
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Provider error text is reflected back to the browser: no control characters, bounded length. */
const cleanError = (v: unknown): string | undefined => {
  const s = str(v);
  return s === undefined ? undefined : [...s].filter((c) => (c >= ' ' && c < '\x7f') || c > '\x9f').join('').slice(0, 120);
};

export type ConnectionsDeps = {
  bus: Bus;
  /** Always present: without a client id yet it reports `clientConfigured: false`. */
  twitch: Pick<TwitchAuth, 'tokens' | 'clientConfigured' | 'setClient' | 'startDeviceFlow' | 'pollDeviceFlow' | 'clear'>;
  youtube: Pick<
    YouTubeAuth,
    'clientConfigured' | 'connected' | 'account' | 'setClient' | 'setAccount' | 'beginAuth' | 'completeAuth' | 'accessToken' | 'clearTokens'
  >;
  youtubeApi: Pick<YouTubeApi, 'myChannelTitle'>;
  x: Pick<
    XAuth,
    'clientConfigured' | 'connected' | 'account' | 'setClient' | 'setAccount' | 'beginAuth' | 'completeAuth' | 'accessToken' | 'clearTokens'
  >;
  xApi: Pick<XApi, 'me'>;
  restart(platform: Platform): void;
  halt(platform: Platform): Promise<void>;
};

/** Turns connections.cmd.* into auth flows; publishes retained connections.state. Never publishes secrets. */
export class ConnectionsService {
  private twitchAbort: AbortController | null = null;

  constructor(private readonly deps: ConnectionsDeps) {}

  start() {
    this.state(this.twitchIdle());
    this.state(this.youtubeIdle());
    this.state(this.xIdle());
    this.state({ platform: 'kick', state: 'disconnected', detail: KICK_NOTE });
    this.deps.bus.subscribe(['connections.cmd.'], (e) => void this.handle(e));
  }

  /** A connector stopped because the user must reconnect: show it on that platform's Settings page. */
  authLost(platform: 'twitch' | 'youtube' | 'x', detail: string) {
    this.state({ platform, state: 'error', clientConfigured: true, detail });
  }

  async handleYouTubeCallback(query: Record<string, string | undefined>): Promise<string> {
    const { youtube } = this.deps;
    try {
      await youtube.completeAuth({ code: str(query.code), state: str(query.state), error: cleanError(query.error) });
      const title = await this.deps.youtubeApi.myChannelTitle(await youtube.accessToken()).catch(() => undefined);
      await youtube.setAccount(title);
      if (!youtube.connected()) {
        // Disconnected while the sign-in was finishing: the disconnect wins.
        this.state(this.youtubeIdle());
        return 'YouTube was disconnected before sign-in finished.';
      }
      this.state({ platform: 'youtube', state: 'connected', clientConfigured: true, ...(title ? { account: title } : {}) });
      this.deps.restart('youtube');
      return 'YouTube is connected. You can close this tab and go back to streamhub.';
    } catch (err) {
      const detail = describeError(err);
      this.state({ platform: 'youtube', state: 'error', clientConfigured: youtube.clientConfigured(), detail });
      return `YouTube connection failed: ${detail}`;
    }
  }

  async handleXCallback(query: Record<string, string | undefined>): Promise<string> {
    const { x } = this.deps;
    try {
      await x.completeAuth({ code: str(query.code), state: str(query.state), error: cleanError(query.error) });
      const user = await this.deps.xApi.me(await x.accessToken()).catch(() => undefined);
      await x.setAccount(user);
      if (!x.connected()) {
        // Disconnected while the sign-in was finishing: the disconnect wins.
        this.state(this.xIdle());
        return 'X was disconnected before sign-in finished.';
      }
      this.state(this.xIdle());
      this.deps.restart('x');
      return 'X is connected. You can close this tab and go back to streamhub.';
    } catch (err) {
      const detail = describeError(err);
      this.state({ platform: 'x', state: 'error', clientConfigured: x.clientConfigured(), detail });
      return `X connection failed: ${detail}`;
    }
  }

  private async handle(e: Envelope) {
    try {
      switch (e.type) {
        case 'connections.cmd.connect':
          return await this.connect((e.payload as EventPayload<'connections.cmd.connect'>).platform);
        case 'connections.cmd.disconnect':
          return await this.disconnect((e.payload as EventPayload<'connections.cmd.disconnect'>).platform);
        case 'connections.cmd.setTwitchClient': {
          const p = e.payload as EventPayload<'connections.cmd.setTwitchClient'>;
          await this.deps.halt('twitch');
          await this.deps.twitch.setClient(p.clientId);
          this.state(this.twitchIdle());
          return;
        }
        case 'connections.cmd.setYoutubeClient': {
          const p = e.payload as EventPayload<'connections.cmd.setYoutubeClient'>;
          await this.deps.halt('youtube');
          await this.deps.youtube.setClient(p.clientId, p.clientSecret);
          this.state(this.youtubeIdle());
          return;
        }
        case 'connections.cmd.setXClient': {
          const p = e.payload as EventPayload<'connections.cmd.setXClient'>;
          await this.deps.halt('x');
          await this.deps.x.setClient(p.clientId);
          this.state(this.xIdle());
          return;
        }
      }
    } catch (err) {
      console.warn(`[connections] ${e.type} failed: ${describeError(err)}`);
    }
  }

  private async connect(platform: Platform) {
    if (platform === 'kick') return this.state({ platform: 'kick', state: 'error', detail: KICK_NOTE });
    if (platform === 'youtube') return this.connectYouTube();
    if (platform === 'x') return this.connectX();
    return this.connectTwitch();
  }

  private async connectTwitch() {
    const { twitch } = this.deps;
    if (!twitch.clientConfigured()) {
      return this.state({ platform: 'twitch', state: 'error', clientConfigured: false, detail: TWITCH_SETUP });
    }
    this.twitchAbort?.abort();
    const abort = new AbortController();
    this.twitchAbort = abort;
    try {
      const code = await twitch.startDeviceFlow();
      if (abort.signal.aborted) return;
      this.state({ platform: 'twitch', state: 'pending', userCode: code.userCode, verificationUri: code.verificationUri });
      const tokens = await twitch.pollDeviceFlow(code, abort.signal);
      if (abort.signal.aborted) return;
      this.state({ platform: 'twitch', state: 'connected', account: tokens.login });
      this.deps.restart('twitch');
    } catch (err) {
      if (!abort.signal.aborted) this.state({ platform: 'twitch', state: 'error', detail: describeError(err) });
    }
  }

  private connectYouTube() {
    const { youtube } = this.deps;
    if (!youtube.clientConfigured()) {
      return this.state({ platform: 'youtube', state: 'error', clientConfigured: false, detail: YOUTUBE_SETUP });
    }
    this.state({ platform: 'youtube', state: 'pending', clientConfigured: true, authUrl: youtube.beginAuth() });
  }

  private connectX() {
    const { x } = this.deps;
    if (!x.clientConfigured()) {
      return this.state({ platform: 'x', state: 'error', clientConfigured: false, detail: X_SETUP });
    }
    this.state({ platform: 'x', state: 'pending', clientConfigured: true, authUrl: x.beginAuth() });
  }

  private async disconnect(platform: Platform) {
    if (platform === 'kick') return;
    if (platform === 'twitch') this.twitchAbort?.abort();
    await this.deps.halt(platform);
    if (platform === 'twitch') {
      await this.deps.twitch.clear();
      return this.state(this.twitchIdle());
    }
    if (platform === 'x') {
      await this.deps.x.clearTokens();
      return this.state(this.xIdle());
    }
    await this.deps.youtube.clearTokens();
    this.state(this.youtubeIdle());
  }

  private twitchIdle(): ConnectionState {
    const { twitch } = this.deps;
    const t = twitch.tokens();
    if (t) return { platform: 'twitch', state: 'connected', account: t.login, clientConfigured: true };
    return { platform: 'twitch', state: 'disconnected', clientConfigured: twitch.clientConfigured() };
  }

  private youtubeIdle(): ConnectionState {
    const { youtube } = this.deps;
    if (youtube.connected()) {
      const account = youtube.account();
      return { platform: 'youtube', state: 'connected', clientConfigured: true, ...(account ? { account } : {}) };
    }
    return { platform: 'youtube', state: 'disconnected', clientConfigured: youtube.clientConfigured() };
  }

  private xIdle(): ConnectionState {
    const { x } = this.deps;
    if (x.connected()) {
      const account = x.account();
      return { platform: 'x', state: 'connected', clientConfigured: true, ...(account ? { account } : {}) };
    }
    return { platform: 'x', state: 'disconnected', clientConfigured: x.clientConfigured() };
  }

  private state(payload: ConnectionState) {
    this.deps.bus.publish({ type: 'connections.state', payload, source: 'hub' });
  }
}
