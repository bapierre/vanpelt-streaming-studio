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
