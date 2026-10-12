import { describe, expect, it } from 'vitest';
import type { AudioState, CameraState, HeadsetsState, MicState, RecordingSession } from '@streamhub/shared';
import { defaultAlertsConfig } from '@streamhub/shared';
import { preflightChecks, summarize, type PreflightInput } from './preflight';
import { initialState, type DashboardState } from './state';

const GB = 1024 ** 3;

const mic = (over: Partial<MicState> = {}): MicState => ({
  id: 'host',
  name: 'Host',
  input: 'Host mic',
  channel: 'both',
  track: 2,
  status: 'ok',
  live: true,
  onStream: true,
  volumeDb: 0,
  muted: false,
  monitor: 'off',
  syncOffsetMs: 0,
  filters: {} as MicState['filters'],
  ...over,
});
const audio = (mics: MicState[] = [mic()]): AudioState => ({ mics, targetDb: -20, recordTracks: [1, 2], tracksPending: false });
const recording = (over: Partial<RecordingSession> = {}): RecordingSession => ({
  output: 'stopped',
  cameras: [],
  disk: { path: '/Movies', freeBytes: 200 * GB, level: 'ok' },
  ...over,
});
const headsets = (over: Partial<HeadsetsState> = {}): HeadsetsState => ({
  plugin: true,
  pluginPending: false,
  outputs: ['USB Audio'],
  sources: [],
  stream: {},
  labels: {},
  headsets: [
    { id: 'guest', name: 'Guest phones', device: 'USB Audio', owner: null, masterDb: 0, muted: false, mirror: null, status: 'ok', sends: {} },
  ],
  ...over,
});

/** Hub and OBS up, a key in OBS, Twitch connected: a show that is ready to go. */
const ready = (): DashboardState => ({
  ...initialState,
  hubConnected: true,
  obs: { connected: true },
  destinations: {
    destinations: [{ id: 'twitch', label: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'k' }],
    inObs: 'twitch',
    obsKeySet: true,
  },
  connections: { twitch: { platform: 'twitch', state: 'connected', account: 'yatf' } },
  platforms: { twitch: { status: 'offline' } },
});

const input = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  state: ready(),
  audio: audio(),
  headsets: null,
  recording: recording(),
  cameras: [],
  alerts: defaultAlertsConfig(),
  ...over,
});
const problems = (i: PreflightInput) => preflightChecks(i).filter((c) => c.status !== 'ok');

describe('preflightChecks', () => {
  it('passes a ready show and says what it checked', () => {
    const checks = preflightChecks(input());
    expect(checks.map((c) => [c.status, c.title])).toEqual([
      ['ok', 'OBS is connected'],
      ['ok', 'Streaming to Twitch'],
      ['ok', 'Twitch is connected'],
      ['ok', '1 mic ready'],
      ['ok', '200 GB free for recording'],
    ]);
    expect(summarize(checks)).toEqual({ level: 'ok', fails: 0, warns: 0, label: 'Ready' });
  });

  it('only reports the hub when the dashboard cannot reach it', () => {
    const checks = preflightChecks(input({ state: initialState }));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'hub', status: 'fail' });
  });

  it('skips everything that needs OBS when OBS is down, and links to its settings', () => {
    const state = { ...ready(), obs: { connected: false, detail: 'connect ECONNREFUSED' } };
    const checks = preflightChecks(input({ state, audio: audio([mic({ status: 'offline' })]) }));
    expect(checks.map((c) => c.id)).toEqual(['obs', 'platform-twitch']);
    expect(checks[0]).toMatchObject({ status: 'fail', detail: 'connect ECONNREFUSED', fix: { tab: 'settings', section: 'obs' } });
  });

  it('fails when OBS has no stream key, and says nothing until OBS has been asked', () => {
    const noKey = { ...ready(), destinations: { destinations: [], inObs: null, obsKeySet: false } };
    expect(problems(input({ state: noKey }))).toMatchObject([
      { id: 'stream-key', status: 'fail', fix: { section: 'destinations' } },
    ]);
    const unknown = { ...ready(), destinations: { destinations: [], inObs: null } };
    expect(preflightChecks(input({ state: unknown })).some((c) => c.id === 'stream-key')).toBe(false);
    const elsewhere = { ...ready(), destinations: { destinations: [], inObs: null, obsKeySet: true } };
    expect(preflightChecks(input({ state: elsewhere }))).toContainEqual({ id: 'stream-key', status: 'ok', title: 'OBS has a stream key' });
  });

  it('warns about platforms that need a new sign-in or have no connection at all', () => {
    const broken = {
      ...ready(),
      connections: { twitch: { platform: 'twitch' as const, state: 'error' as const, detail: 'Sign-in expired' } },
    };
    expect(problems(input({ state: broken }))).toMatchObject([
      { id: 'platform-twitch', status: 'warn', title: 'Twitch needs to reconnect', detail: 'Sign-in expired' },
    ]);
    expect(problems(input({ state: { ...ready(), connections: {} } }))).toMatchObject([{ id: 'platforms', status: 'warn' }]);
    const chatDown = { ...ready(), platforms: { twitch: { status: 'error' as const, detail: 'EventSub closed' } } };
    expect(problems(input({ state: chatDown }))).toMatchObject([{ title: 'Twitch chat has a problem', detail: 'EventSub closed' }]);
  });

  it('flags missing, off-scene and muted mics, and counts the ready ones', () => {
    const mics = [
      mic(),
      mic({ id: 'lost', name: 'Lost', status: 'missing', detail: 'No input "Old mic" in OBS' }),
      mic({ id: 'guest', name: 'Guest', live: false }),
      mic({ id: 'cohost', name: 'Cohost', muted: true }),
    ];
    const checks = preflightChecks(input({ audio: audio(mics) }));
    expect(checks.filter((c) => c.id.startsWith('mic')).map((c) => [c.status, c.title])).toEqual([
      ['fail', "Lost's mic is missing"],
      ['warn', 'Guest is not in the live scene'],
      ['warn', 'Cohost is muted'],
      ['ok', '1 mic ready'],
    ]);
    expect(problems(input({ audio: audio([]) }))).toMatchObject([{ id: 'mics', fix: { tab: 'sound' } }]);
  });

  it('checks headsets only when there are some', () => {
    expect(problems(input({ headsets: headsets({ headsets: [], plugin: false }) }))).toEqual([]);
    expect(problems(input({ headsets: headsets({ plugin: false }) }))).toMatchObject([
      { id: 'headsets', title: 'Headset mixes need the Audio Monitor plugin' },
    ]);
    const unplugged = headsets();
    unplugged.headsets[0] = { ...unplugged.headsets[0]!, detail: '"USB Audio" is not plugged in' };
    expect(problems(input({ headsets: unplugged }))).toMatchObject([{ title: 'Guest phones', detail: '"USB Audio" is not plugged in' }]);
  });

  it('turns a nearly full disk into a problem and missing camera files into warnings', () => {
    const r = recording({
      disk: { path: '/Movies', freeBytes: 3 * GB, level: 'critical', minutesLeft: 12 },
      cameras: [
        { id: 'wide', name: 'Wide', mode: 'obs', iso: 'no-plugin' },
        { id: 'close', name: 'Close', mode: 'obs', iso: 'no-plugin' },
        { id: 'top', name: 'Top', mode: 'obs', iso: 'no-source', detail: 'No OBS source "Top cam"' },
      ],
    });
    expect(problems(input({ recording: r })).map((c) => [c.status, c.title])).toEqual([
      ['fail', 'Disk almost full: 3.0 GB free (about 12 min left)'],
      ['warn', 'Camera files need the Source Record plugin'],
      ['warn', 'Top will not record its own file'],
    ]);
  });

  it('warns about broken cameras and paused alerts', () => {
    const cam: CameraState = { id: 'gopro', name: 'GoPro', driver: 'gopro', status: 'disconnected', scene: 'GoPro', onAir: false, controls: [] };
    const alerts = { ...defaultAlertsConfig(), paused: true };
    expect(problems(input({ cameras: [cam, { ...cam, id: 'desk', name: 'Desk', driver: null }], alerts })).map((c) => c.title)).toEqual([
      'GoPro is disconnected',
      'Alerts are paused',
    ]);
  });
});

describe('summarize', () => {
  it('counts problems before warnings', () => {
    expect(summarize([{ id: 'a', status: 'warn', title: 'a' }])).toMatchObject({ level: 'warn', label: '1 to check' });
    expect(
      summarize([
        { id: 'a', status: 'warn', title: 'a' },
        { id: 'b', status: 'fail', title: 'b' },
        { id: 'c', status: 'fail', title: 'c' },
      ]),
    ).toEqual({ level: 'fail', fails: 2, warns: 1, label: '2 problems' });
  });
});
