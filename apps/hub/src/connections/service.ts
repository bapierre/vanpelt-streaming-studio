import type { ConnectionState, Envelope, EventPayload, Platform } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { TwitchAuth } from '../connectors/twitch/auth';
import type { YouTubeApi } from '../connectors/youtube/api';
import type { YouTubeAuth } from '../connectors/youtube/auth';
import { describeError } from '../util/errors';

const KICK_NOTE = 'Kick arrives with the relay (M3).';
const TWITCH_SETUP = 'Set TWITCH_CLIENT_ID in .env (see docs/setup/twitch.md), then restart streamhub.';
const YOUTUBE_SETUP = 'Add your Google OAuth client first (see docs/setup/youtube.md).';

export type ConnectionsDeps = {
  bus: Bus;
  twitch: Pick<TwitchAuth, 'tokens' | 'startDeviceFlow' | 'pollDeviceFlow' | 'clear'> | null;
  youtube: Pick<
    YouTubeAuth,
    'clientConfigured' | 'connected' | 'account' | 'setClient' | 'setAccount' | 'beginAuth' | 'completeAuth' | 'accessToken' | 'clearTokens'
  >;
  youtubeApi: Pick<YouTubeApi, 'myChannelTitle'>;
  restart(platform: Platform): void;
  halt(platform: Platform): Promise<void>;
};

/** Turns connections.cmd.* into auth flows; publishes retained connections.state. Never publishes secrets. */
export class ConnectionsService {
  private twitchAbort: AbortController | null = null;

  constructor(private readonly deps: ConnectionsDeps) {}

  start() {
    const { twitch } = this.deps;
    const t = twitch?.tokens();
    this.state(
      t ? { platform: 'twitch', state: 'connected', account: t.login } : { platform: 'twitch', state: 'disconnected', ...(twitch ? {} : { detail: TWITCH_SETUP }) },
    );
    this.state(this.youtubeIdle());
    this.state({ platform: 'kick', state: 'disconnected', detail: KICK_NOTE });
    this.deps.bus.subscribe(['connections.cmd.'], (e) => void this.handle(e));
  }

  async handleYouTubeCallback(query: Record<string, string | undefined>): Promise<string> {
    const { youtube } = this.deps;
    try {
      await youtube.completeAuth({ code: query.code, state: query.state, error: query.error });
      const title = await this.deps.youtubeApi.myChannelTitle(await youtube.accessToken()).catch(() => undefined);
      await youtube.setAccount(title);
      this.state({ platform: 'youtube', state: 'connected', clientConfigured: true, ...(title ? { account: title } : {}) });
      this.deps.restart('youtube');
      return 'YouTube is connected. You can close this tab and go back to streamhub.';
    } catch (err) {
      const detail = describeError(err);
      this.state({ platform: 'youtube', state: 'error', clientConfigured: youtube.clientConfigured(), detail });
      return `YouTube connection failed: ${detail}`;
    }
  }

  private async handle(e: Envelope) {
    try {
      switch (e.type) {
        case 'connections.cmd.connect':
          return await this.connect((e.payload as EventPayload<'connections.cmd.connect'>).platform);
        case 'connections.cmd.disconnect':
          return await this.disconnect((e.payload as EventPayload<'connections.cmd.disconnect'>).platform);
        case 'connections.cmd.setYoutubeClient': {
          const p = e.payload as EventPayload<'connections.cmd.setYoutubeClient'>;
          await this.deps.halt('youtube');
          await this.deps.youtube.setClient(p.clientId, p.clientSecret);
          this.state(this.youtubeIdle());
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
    return this.connectTwitch();
  }

  private async connectTwitch() {
    const { twitch } = this.deps;
    if (!twitch) return this.state({ platform: 'twitch', state: 'error', detail: TWITCH_SETUP });
    this.twitchAbort?.abort();
    const abort = new AbortController();
    this.twitchAbort = abort;
    try {
      const code = await twitch.startDeviceFlow();
      this.state({ platform: 'twitch', state: 'pending', userCode: code.userCode, verificationUri: code.verificationUri });
      const tokens = await twitch.pollDeviceFlow(code, abort.signal);
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

  private async disconnect(platform: Platform) {
    if (platform === 'kick') return;
    await this.deps.halt(platform);
    if (platform === 'twitch') {
      this.twitchAbort?.abort();
      await this.deps.twitch?.clear();
      return this.state({ platform: 'twitch', state: 'disconnected', ...(this.deps.twitch ? {} : { detail: TWITCH_SETUP }) });
    }
    await this.deps.youtube.clearTokens();
    this.state(this.youtubeIdle());
  }

  private youtubeIdle(): ConnectionState {
    const { youtube } = this.deps;
    if (youtube.connected()) {
      const account = youtube.account();
      return { platform: 'youtube', state: 'connected', clientConfigured: true, ...(account ? { account } : {}) };
    }
    return { platform: 'youtube', state: 'disconnected', clientConfigured: youtube.clientConfigured() };
  }

  private state(payload: ConnectionState) {
    this.deps.bus.publish({ type: 'connections.state', payload, source: 'hub' });
  }
}
