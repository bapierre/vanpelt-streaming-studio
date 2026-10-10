import { describe, expect, it } from 'vitest';
import { validatePayload } from './events';
import { ClientOpSchema } from './protocol';
import { chatMessage } from './testing';

describe('validatePayload', () => {
  it('accepts a valid chat message', () => {
    expect(validatePayload('chat.message', chatMessage())).toMatchObject({ ok: true });
  });
  it('rejects a platform that is not in v0', () => {
    const r = validatePayload('chat.message', chatMessage({ platform: 'x' as never }));
    expect(r.ok).toBe(false);
  });
  it('rejects unknown event types', () => {
    expect(validatePayload('nope.nothing', {})).toEqual({
      ok: false,
      error: 'unknown event type: nope.nothing',
    });
  });
  it('accepts any payload for module events', () => {
    expect(validatePayload('module.roast-o-meter.vote', { score: 3 })).toMatchObject({ ok: true });
  });
  it('rejects malformed module event names', () => {
    expect(validatePayload('module..vote', {}).ok).toBe(false);
  });
  it('rejects an empty scene name', () => {
    expect(validatePayload('obs.cmd.setScene', { scene: '' }).ok).toBe(false);
  });
  it('rejects extra keys on empty-payload commands', () => {
    expect(validatePayload('obs.cmd.startStream', {}).ok).toBe(true);
    expect(validatePayload('obs.cmd.startStream', { force: true }).ok).toBe(false);
  });
  it('describes the failing field', () => {
    const r = validatePayload('obs.scene.changed', { scene: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('scene');
  });
});

describe('M2 events', () => {
  it('accepts chat.cleared with and without an author', () => {
    expect(validatePayload('chat.cleared', { platform: 'twitch' }).ok).toBe(true);
    expect(validatePayload('chat.cleared', { platform: 'youtube', authorId: 'UC1' }).ok).toBe(true);
  });
  it('accepts a pending Twitch connection state', () => {
    const r = validatePayload('connections.state', {
      platform: 'twitch',
      state: 'pending',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
    });
    expect(r.ok).toBe(true);
  });
  it('trims and requires the YouTube client credentials', () => {
    expect(validatePayload('connections.cmd.setYoutubeClient', { clientId: '  ', clientSecret: 's' }).ok).toBe(false);
    expect(validatePayload('connections.cmd.setYoutubeClient', { clientId: ' id ', clientSecret: ' s ' })).toEqual({
      ok: true,
      payload: { clientId: 'id', clientSecret: 's' },
    });
  });
  it('rejects connecting an unknown platform', () => {
    expect(validatePayload('connections.cmd.connect', { platform: 'x' }).ok).toBe(false);
  });
});

describe('camera events', () => {
  const driverState = {
    id: 'gopro',
    status: 'ready',
    controls: [
      { key: 'fov', label: 'Lens', kind: 'select', value: '0', options: [{ value: '0', label: 'Wide' }] },
      { key: 'zoom', label: 'Zoom', kind: 'range', value: 0, min: 0, max: 100, step: 1 },
    ],
  };
  it('accepts a driver state with select and range controls', () => {
    expect(validatePayload('camera.driver.state', driverState).ok).toBe(true);
  });
  it('rejects driver controls that claim the obs. namespace', () => {
    const r = validatePayload('camera.driver.state', {
      ...driverState,
      controls: [{ key: 'obs.brightness', label: 'B', kind: 'toggle', value: true }],
    });
    expect(r.ok).toBe(false);
  });
  it('rejects camera ids that are not slugs', () => {
    expect(validatePayload('camera.cmd.take', { id: 'Go Pro' }).ok).toBe(false);
    expect(validatePayload('camera.cmd.take', { id: 'gopro' }).ok).toBe(true);
  });
  it('accepts null as the value of an action', () => {
    expect(validatePayload('camera.cmd.set', { id: 'sony', key: 'obs.reset', value: null }).ok).toBe(true);
    expect(validatePayload('camera.cmd.set', { id: 'sony', key: 'obs.reset', value: {} }).ok).toBe(false);
  });
});

describe('audio events', () => {
  it('accepts a partial filter patch and rejects out-of-range values', () => {
    expect(validatePayload('audio.cmd.set', { id: 'host', filters: { compressor: { ratio: 4 } } }).ok).toBe(true);
    expect(validatePayload('audio.cmd.set', { id: 'host', filters: { gain: { db: 40 } } }).ok).toBe(false);
    expect(validatePayload('audio.cmd.set', { id: 'host', volumeDb: 30 }).ok).toBe(false);
  });
  it('defaults a new mic to both channels', () => {
    const r = validatePayload('audio.cmd.add', { name: 'Guest', from: { kind: 'device', device: 'usb-1' } });
    expect(r.ok && (r.payload as { channel: string }).channel).toBe('both');
  });
  it('limits the sound check length', () => {
    expect(validatePayload('audio.cmd.soundcheck', { id: 'host', action: 'start', seconds: 60 }).ok).toBe(false);
  });
});

describe('ClientOpSchema', () => {
  it('defaults history limit to 50', () => {
    const op = ClientOpSchema.parse({ op: 'history', reqId: 'r1', topic: 'chat.message' });
    expect(op).toEqual({ op: 'history', reqId: 'r1', topic: 'chat.message', limit: 50 });
  });
  it('rejects history limits above 200', () => {
    expect(
      ClientOpSchema.safeParse({ op: 'history', reqId: 'r', topic: 'chat.message', limit: 500 })
        .success,
    ).toBe(false);
  });
  it('rejects unknown ops', () => {
    expect(ClientOpSchema.safeParse({ op: 'shutdown' }).success).toBe(false);
  });
});
