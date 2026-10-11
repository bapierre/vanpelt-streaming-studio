import { describe, expect, it } from 'vitest';
import { validatePayload } from './events';

const session = {
  output: 'recording',
  startedAt: 1,
  directory: '/Users/me/Movies',
  cameras: [{ id: 'wide', name: 'Wide', mode: 'both', iso: 'recording', card: 'recording' }],
  disk: { path: '/Users/me/Movies', freeBytes: 5e10, level: 'ok', minutesLeft: 300 },
  lastSession: {
    endedAt: 2,
    files: [
      { kind: 'program', label: 'Program', location: '/Users/me/Movies/a.mkv' },
      { kind: 'card', cameraId: 'wide', label: 'Wide (card)', location: "On Wide's card" },
    ],
  },
};

describe('recording contract', () => {
  it('accepts a full recording session', () => {
    expect(validatePayload('recording.state', session).ok).toBe(true);
  });
  it('rejects an unknown camera record mode', () => {
    const bad = { ...session, cameras: [{ ...session.cameras[0], mode: 'cloud' }] };
    expect(validatePayload('recording.state', bad).ok).toBe(false);
  });
  it('accepts card support in driver state', () => {
    const state = { id: 'wide', status: 'ready', controls: [], card: { supported: true, recording: false } };
    expect(validatePayload('camera.driver.state', state).ok).toBe(true);
  });
  it('requires an on flag for driver record commands', () => {
    expect(validatePayload('camera.driver.cmd.record', { id: 'wide', on: true }).ok).toBe(true);
    expect(validatePayload('camera.driver.cmd.record', { id: 'wide' }).ok).toBe(false);
  });
});
