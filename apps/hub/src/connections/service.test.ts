import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import { settle } from '../testing/timer';
import { ConnectionsService, type ConnectionsDeps } from './service';

let bus: Bus;
let all: Envelope[];
let twitch: { [K in 'tokens' | 'startDeviceFlow' | 'pollDeviceFlow' | 'clear']: ReturnType<typeof vi.fn> };
let youtube: Record<string, ReturnType<typeof vi.fn>>;
let x: Record<string, ReturnType<typeof vi.fn>>;
let xApi: { me: ReturnType<typeof vi.fn> };
let restart: ReturnType<typeof vi.fn>;
let halt: ReturnType<typeof vi.fn>;
let service: ConnectionsService;

const make = (overrides: Partial<ConnectionsDeps> = {}) =>
  new ConnectionsService({
    bus,
    twitch: twitch as never,
    youtube: youtube as never,
    youtubeApi: { myChannelTitle: vi.fn(async () => 'Your Average Tech Founder') },
    x: x as never,
    xApi: xApi as never,
    restart: restart as never,
    halt: halt as never,
    ...overrides,
  });

beforeEach(() => {
  bus = new Bus();
  all = [];
  bus.subscribe(['*'], (e) => all.push(e));
  twitch = {
    tokens: vi.fn(() => undefined),
    startDeviceFlow: vi.fn(async () => ({ deviceCode: 'd', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH', intervalMs: 5000, expiresAt: 1e15 })),
    pollDeviceFlow: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', userId: '1', login: 'yatf' })),
    clear: vi.fn(async () => {}),
  };
  let configured = false;
  youtube = {
    clientConfigured: vi.fn(() => configured),
    connected: vi.fn(() => false),
    account: vi.fn(() => undefined),
    setClient: vi.fn(async () => void (configured = true)),
    setAccount: vi.fn(async () => {}),
    beginAuth: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?x=1'),
    completeAuth: vi.fn(async () => {}),
    accessToken: vi.fn(async () => 'tok'),
    clearTokens: vi.fn(async () => {}),
  };
  let xConfigured = false;
  x = {
    clientConfigured: vi.fn(() => xConfigured),
    connected: vi.fn(() => false),
    account: vi.fn(() => undefined),
    setClient: vi.fn(async () => void (xConfigured = true)),
    setAccount: vi.fn(async () => {}),
    beginAuth: vi.fn(() => 'https://x.com/i/oauth2/authorize?x=1'),
    completeAuth: vi.fn(async () => {}),
    accessToken: vi.fn(async () => 'xtok'),
    clearTokens: vi.fn(async () => {}),
  };
  xApi = { me: vi.fn(async () => ({ id: '42', username: 'yatf' })) };
  restart = vi.fn();
  halt = vi.fn(async () => {});
  service = make();
});

const states = (platform: string) =>
  all.filter((e) => e.type === 'connections.state' && (e.payload as { platform: string }).platform === platform).map((e) => e.payload);
const cmd = (type: string, payload: unknown) => bus.publish({ type, payload, source: 'dashboard' });

describe('ConnectionsService', () => {
  it('publishes initial states', () => {
    twitch.tokens.mockReturnValue({ login: 'yatf' });
    service.start();
    expect(states('twitch')).toEqual([{ platform: 'twitch', state: 'connected', account: 'yatf' }]);
    expect(states('youtube')).toEqual([{ platform: 'youtube', state: 'disconnected', clientConfigured: false }]);
    expect(states('kick')).toEqual([{ platform: 'kick', state: 'disconnected', detail: 'Kick arrives with the relay (M3).' }]);
    expect(states('x')).toEqual([{ platform: 'x', state: 'disconnected', clientConfigured: false }]);
  });

  it('explains how to configure Twitch when no client id is set', () => {
    make({ twitch: null }).start();
    expect(states('twitch')[0]).toMatchObject({ state: 'disconnected', detail: expect.stringContaining('TWITCH_CLIENT_ID') });
  });

  it('reports lost Twitch auth as an error and can connect again from it', async () => {
    twitch.tokens.mockReturnValue({ login: 'yatf' });
    service.start();
    service.authLost('twitch', 'Twitch login expired. Reconnect Twitch in Settings → Platforms.');
    expect(states('twitch').at(-1)).toEqual({
      platform: 'twitch',
      state: 'error',
      detail: 'Twitch login expired. Reconnect Twitch in Settings → Platforms.',
    });
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    expect(twitch.startDeviceFlow).toHaveBeenCalled();
    expect(states('twitch').at(-1)).toEqual({ platform: 'twitch', state: 'connected', account: 'yatf' });
    expect(restart).toHaveBeenCalledWith('twitch');
  });

  it('reports lost YouTube auth as an error with the client still configured, and can connect again', async () => {
    youtube.clientConfigured!.mockReturnValue(true);
    service.start();
    service.authLost('youtube', 'YouTube sign-in expired. Reconnect YouTube in Settings → Platforms.');
    expect(states('youtube').at(-1)).toEqual({
      platform: 'youtube',
      state: 'error',
      clientConfigured: true,
      detail: 'YouTube sign-in expired. Reconnect YouTube in Settings → Platforms.',
    });
    cmd('connections.cmd.connect', { platform: 'youtube' });
    await settle();
    expect(states('youtube').at(-1)).toMatchObject({ state: 'pending', authUrl: expect.stringContaining('accounts.google.com') });
  });

  it('runs the Twitch device flow and restarts the connector', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    expect(states('twitch').slice(1)).toEqual([
      { platform: 'twitch', state: 'pending', userCode: 'ABCDEFGH', verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' },
      { platform: 'twitch', state: 'connected', account: 'yatf' },
    ]);
    expect(restart).toHaveBeenCalledWith('twitch');
  });

  it('reports a failed Twitch sign-in', async () => {
    twitch.pollDeviceFlow.mockRejectedValue(new Error('The code expired before it was approved. Try again.'));
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    expect(states('twitch').at(-1)).toEqual({ platform: 'twitch', state: 'error', detail: 'The code expired before it was approved. Try again.' });
  });

  it('disconnects Twitch: stops the connector and forgets tokens', async () => {
    service.start();
    cmd('connections.cmd.disconnect', { platform: 'twitch' });
    await settle();
    expect(halt).toHaveBeenCalledWith('twitch');
    expect(twitch.clear).toHaveBeenCalled();
    expect(states('twitch').at(-1)).toMatchObject({ state: 'disconnected' });
  });

  it('saves the YouTube client and never publishes the client secret', async () => {
    service.start();
    cmd('connections.cmd.setYoutubeClient', { clientId: 'cid', clientSecret: 'TOPSECRET' });
    await settle();
    expect(youtube.setClient).toHaveBeenCalledWith('cid', 'TOPSECRET');
    expect(states('youtube').at(-1)).toEqual({ platform: 'youtube', state: 'disconnected', clientConfigured: true });
    const leaked = all.filter((e) => e.type !== 'connections.cmd.setYoutubeClient' && JSON.stringify(e).includes('TOPSECRET'));
    expect(leaked).toEqual([]);
  });

  it('asks for a client before YouTube sign-in', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'youtube' });
    await settle();
    expect(states('youtube').at(-1)).toMatchObject({ state: 'error', detail: expect.stringContaining('docs/setup/youtube.md') });
  });

  it('runs the YouTube sign-in through the callback', async () => {
    youtube.clientConfigured!.mockReturnValue(true);
    youtube.connected!.mockReturnValue(true);
    service.start();
    cmd('connections.cmd.connect', { platform: 'youtube' });
    await settle();
    expect(states('youtube').at(-1)).toEqual({
      platform: 'youtube',
      state: 'pending',
      clientConfigured: true,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    });
    const page = await service.handleYouTubeCallback({ code: 'c', state: 's' });
    expect(youtube.completeAuth).toHaveBeenCalledWith({ code: 'c', state: 's', error: undefined });
    expect(youtube.setAccount).toHaveBeenCalledWith('Your Average Tech Founder');
    expect(page).toContain('YouTube is connected');
    expect(states('youtube').at(-1)).toEqual({ platform: 'youtube', state: 'connected', clientConfigured: true, account: 'Your Average Tech Founder' });
    expect(restart).toHaveBeenCalledWith('youtube');
  });

  it('reports a rejected YouTube callback', async () => {
    youtube.clientConfigured!.mockReturnValue(true);
    youtube.completeAuth!.mockRejectedValue(new Error('This sign-in link is invalid or expired.'));
    service.start();
    const page = await service.handleYouTubeCallback({ state: 'forged', code: 'c' });
    expect(page).toContain('invalid or expired');
    expect(states('youtube').at(-1)).toMatchObject({ state: 'error' });
    expect(restart).not.toHaveBeenCalled();
  });

  it('answers Kick with the M3 note', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'kick' });
    await settle();
    expect(states('kick').at(-1)).toMatchObject({ state: 'error', detail: 'Kick arrives with the relay (M3).' });
  });

  it('disconnect during startDeviceFlow leaves the state disconnected', async () => {
    let resolveStart!: (v: unknown) => void;
    twitch.startDeviceFlow.mockReturnValue(new Promise((r) => (resolveStart = r)));
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    cmd('connections.cmd.disconnect', { platform: 'twitch' });
    await settle();
    resolveStart({ deviceCode: 'd', userCode: 'STALE', verificationUri: 'https://x', intervalMs: 1, expiresAt: 1e15 });
    await settle();
    expect(states('twitch').at(-1)).toMatchObject({ state: 'disconnected' });
    expect(states('twitch').some((s) => (s as { state: string }).state === 'pending')).toBe(false);
    expect(twitch.pollDeviceFlow).not.toHaveBeenCalled();
  });

  it('disconnect while the poll resolves does not publish connected or restart', async () => {
    let resolvePoll!: (v: unknown) => void;
    twitch.pollDeviceFlow.mockReturnValue(new Promise((r) => (resolvePoll = r)));
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    cmd('connections.cmd.disconnect', { platform: 'twitch' });
    await settle();
    resolvePoll({ accessToken: 'a', refreshToken: 'r', userId: '1', login: 'yatf' });
    await settle();
    expect(states('twitch').at(-1)).toMatchObject({ state: 'disconnected' });
    expect(states('twitch').some((s) => (s as { state: string }).state === 'connected')).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it('a second connect supersedes the first flow', async () => {
    const mk = (userCode: string) => ({ deviceCode: userCode, userCode, verificationUri: `https://x/${userCode}`, intervalMs: 1, expiresAt: 1e15 });
    let resolveFirst!: (v: unknown) => void;
    twitch.startDeviceFlow.mockReturnValueOnce(new Promise((r) => (resolveFirst = r))).mockResolvedValueOnce(mk('SECOND'));
    twitch.pollDeviceFlow.mockReturnValue(new Promise(() => {}));
    service.start();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    cmd('connections.cmd.connect', { platform: 'twitch' });
    await settle();
    resolveFirst(mk('FIRST'));
    await settle();
    expect(states('twitch').at(-1)).toMatchObject({ state: 'pending', userCode: 'SECOND' });
  });

  it('survives halt rejecting during setYoutubeClient', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    halt.mockRejectedValueOnce(new Error('stop failed'));
    service.start();
    cmd('connections.cmd.setYoutubeClient', { clientId: 'cid', clientSecret: 's' });
    await settle();
    cmd('connections.cmd.connect', { platform: 'kick' });
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(states('kick').at(-1)).toMatchObject({ state: 'error' });
  });

  it('survives setClient rejecting', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    youtube.setClient!.mockRejectedValueOnce(new Error('disk full'));
    service.start();
    cmd('connections.cmd.setYoutubeClient', { clientId: 'cid', clientSecret: 's' });
    await settle();
    cmd('connections.cmd.connect', { platform: 'kick' });
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(states('kick').at(-1)).toMatchObject({ state: 'error' });
  });

  it('does not publish connected or restart when YouTube was disconnected mid sign-in', async () => {
    youtube.clientConfigured!.mockReturnValue(true);
    youtube.connected!.mockReturnValue(false);
    service.start();
    await service.handleYouTubeCallback({ code: 'c', state: 's' });
    expect(states('youtube').some((s) => (s as { state: string }).state === 'connected')).toBe(false);
    expect(states('youtube').at(-1)).toMatchObject({ state: 'disconnected' });
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('ConnectionsService X', () => {
  it('publishes a connected X account at start', () => {
    x.connected!.mockReturnValue(true);
    x.clientConfigured!.mockReturnValue(true);
    x.account!.mockReturnValue('@yatf');
    service.start();
    expect(states('x')).toEqual([{ platform: 'x', state: 'connected', clientConfigured: true, account: '@yatf' }]);
  });

  it('saves the X client id after halting the connector, without leaking it', async () => {
    service.start();
    cmd('connections.cmd.setXClient', { clientId: ' XCLIENTID ' });
    await settle();
    expect(halt).toHaveBeenCalledWith('x');
    expect(x.setClient).toHaveBeenCalledWith('XCLIENTID');
    expect(states('x').at(-1)).toEqual({ platform: 'x', state: 'disconnected', clientConfigured: true });
    const leaked = all.filter((e) => e.type !== 'connections.cmd.setXClient' && JSON.stringify(e).includes('XCLIENTID'));
    expect(leaked).toEqual([]);
  });

  it('asks for a client id before X sign-in', async () => {
    service.start();
    cmd('connections.cmd.connect', { platform: 'x' });
    await settle();
    expect(states('x').at(-1)).toEqual({
      platform: 'x',
      state: 'error',
      clientConfigured: false,
      detail: 'Add your X app client ID first (see docs/setup/x.md).',
    });
    expect(x.beginAuth).not.toHaveBeenCalled();
  });

  it('runs the X sign-in through the callback', async () => {
    x.clientConfigured!.mockReturnValue(true);
    service.start();
    cmd('connections.cmd.connect', { platform: 'x' });
    await settle();
    expect(states('x').at(-1)).toEqual({
      platform: 'x',
      state: 'pending',
      clientConfigured: true,
      authUrl: 'https://x.com/i/oauth2/authorize?x=1',
    });
    x.connected!.mockReturnValue(true);
    x.account!.mockReturnValue('@yatf');
    const page = await service.handleXCallback({ code: 'c', state: 's' });
    expect(x.completeAuth).toHaveBeenCalledWith({ code: 'c', state: 's', error: undefined });
    expect(xApi.me).toHaveBeenCalledWith('xtok');
    expect(x.setAccount).toHaveBeenCalledWith({ id: '42', username: 'yatf' });
    expect(page).toContain('X is connected');
    expect(states('x').at(-1)).toEqual({ platform: 'x', state: 'connected', clientConfigured: true, account: '@yatf' });
    expect(restart).toHaveBeenCalledWith('x');
  });

  it('reports a rejected X callback', async () => {
    x.clientConfigured!.mockReturnValue(true);
    x.completeAuth!.mockRejectedValue(new Error('This sign-in link is invalid or expired.'));
    service.start();
    const page = await service.handleXCallback({ code: 'c', state: 'forged' });
    expect(page).toContain('X connection failed: This sign-in link is invalid or expired.');
    expect(states('x').at(-1)).toMatchObject({ platform: 'x', state: 'error', clientConfigured: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it('does not restart when X was disconnected mid sign-in', async () => {
    x.clientConfigured!.mockReturnValue(true);
    service.start();
    const page = await service.handleXCallback({ code: 'c', state: 's' });
    expect(page).toContain('disconnected before sign-in finished');
    expect(states('x').at(-1)).toMatchObject({ state: 'disconnected' });
    expect(restart).not.toHaveBeenCalled();
  });

  it('disconnects X: halts the connector and forgets tokens', async () => {
    x.clientConfigured!.mockReturnValue(true);
    service.start();
    cmd('connections.cmd.disconnect', { platform: 'x' });
    await settle();
    expect(halt).toHaveBeenCalledWith('x');
    expect(x.clearTokens).toHaveBeenCalled();
    expect(states('x').at(-1)).toEqual({ platform: 'x', state: 'disconnected', clientConfigured: true });
  });

  it('reports lost X auth as an error with the client still configured', () => {
    service.start();
    service.authLost('x', 'X sign-in expired. Reconnect X in Settings → Platforms.');
    expect(states('x').at(-1)).toEqual({
      platform: 'x',
      state: 'error',
      clientConfigured: true,
      detail: 'X sign-in expired. Reconnect X in Settings → Platforms.',
    });
  });
});
