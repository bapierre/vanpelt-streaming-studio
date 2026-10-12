import { describe, expect, it } from 'vitest';
import { validatePayload } from './events';
import { micSourceKey, obsSourceKey } from './headsets';

const headset = {
  id: 'cohost',
  name: 'Co-host',
  device: 'USB Audio Device',
  owner: 'cohost',
  masterDb: -6,
  muted: false,
  mirror: null,
  status: 'ok',
  sends: { 'mic:host': { on: true, db: 0 }, 'obs:Music': { on: false, db: -12 } },
};
const state = {
  plugin: true,
  pluginPending: false,
  outputs: ['MacBook Pro Speakers', 'USB Audio Device'],
  sources: [
    { key: 'mic:host', name: 'Host', kind: 'mic', live: true },
    { key: 'obs:Music', name: 'Music', kind: 'obs', live: true },
    { key: 'obs:Sony cam', name: 'Sony A6400', kind: 'camera', detail: 'Sony cam', live: false },
  ],
  stream: { 'mic:host': { on: true, db: -3 } },
  labels: { 'obs:Music': 'Walk-in playlist' },
  headsets: [headset],
};

describe('headsets contract', () => {
  it('accepts a full headsets state', () => {
    expect(validatePayload('headsets.state', state).ok).toBe(true);
    expect(validatePayload('headsets.state', { ...state, plugin: null, headsets: [] }).ok).toBe(true);
  });
  it('builds source keys for mics and other OBS audio', () => {
    expect(micSourceKey('host')).toBe('mic:host');
    expect(obsSourceKey('Guest call (VDO)')).toBe('obs:Guest call (VDO)');
  });
  it('rejects source keys of an unknown kind', () => {
    const bad = { ...headset, sends: { 'desktop:x': { on: true, db: 0 } } };
    expect(validatePayload('headsets.state', { ...state, headsets: [bad] }).ok).toBe(false);
    expect(validatePayload('headsets.cmd.setSend', { id: 'cohost', source: 'mic:Host Mic', on: true }).ok).toBe(false);
  });
  it('never allows a level above 0 dB, because the plugin cannot boost', () => {
    expect(validatePayload('headsets.cmd.setSend', { id: 'cohost', source: 'mic:host', db: 3 }).ok).toBe(false);
    expect(validatePayload('headsets.cmd.setSend', { id: 'cohost', source: 'mic:host', db: -61 }).ok).toBe(false);
    expect(validatePayload('headsets.cmd.update', { id: 'cohost', masterDb: 1 }).ok).toBe(false);
    expect(validatePayload('headsets.cmd.setSend', { id: 'cohost', source: 'obs:Music', on: true, db: -60 }).ok).toBe(true);
  });
  it('trims a new headset and defaults it to no owner', () => {
    expect(validatePayload('headsets.cmd.add', { name: ' Guest ', device: ' USB Audio ' })).toEqual({
      ok: true,
      payload: { name: 'Guest', device: 'USB Audio', owner: null },
    });
    expect(validatePayload('headsets.cmd.add', { name: 'Guest', device: '  ' }).ok).toBe(false);
  });
  it('lets an update clear the owner', () => {
    expect(validatePayload('headsets.cmd.update', { id: 'cohost', owner: null }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.update', { id: 'Co Host' }).ok).toBe(false);
  });
  it('takes no options when listing outputs', () => {
    expect(validatePayload('headsets.cmd.listOutputs', {}).ok).toBe(true);
    expect(validatePayload('headsets.cmd.listOutputs', { all: true }).ok).toBe(false);
  });
  it('lets an output mirror the stream or another output, or neither', () => {
    expect(validatePayload('headsets.cmd.update', { id: 'cohost', mirror: 'stream' }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.update', { id: 'cohost', mirror: 'airpods' }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.update', { id: 'cohost', mirror: null }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.update', { id: 'cohost', mirror: 'Co Host' }).ok).toBe(false);
  });
  it('wires sources into the stream with a fader, and renames any source', () => {
    expect(validatePayload('headsets.cmd.setStream', { source: 'obs:Sony cam', on: true }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.setStream', { source: 'obs:Sony cam', db: -12 }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.setStream', { source: 'obs:Sony cam', db: 30 }).ok).toBe(false);
    expect(validatePayload('headsets.cmd.renameSource', { source: 'mic:host', name: ' Shotgun ' }).ok).toBe(true);
    expect(validatePayload('headsets.cmd.renameSource', { source: 'mic:host', name: ' ' }).ok).toBe(false);
  });
});
