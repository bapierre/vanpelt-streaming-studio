import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAudioConfig, micIdFor, saveAudioConfig } from './config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-audio-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('audio config', () => {
  it('starts empty without a file and round-trips what it saves', async () => {
    const path = join(dir, '.streamhub/audio.json');
    expect(await loadAudioConfig(path)).toEqual({ targetDb: -20, mics: [] });
    const cfg = {
      targetDb: -18,
      mics: [{ id: 'host', name: 'Host', input: 'Host mic', channel: 'left' as const, stream: true }],
    };
    await saveAudioConfig(path, cfg);
    expect(await loadAudioConfig(path)).toEqual(cfg);
    expect(await readFile(path, 'utf8')).toMatch(/\n$/);
    // A file written before the stream toggle loads with it on.
    const legacy = join(dir, 'legacy.json');
    await writeFile(legacy, JSON.stringify({ mics: [{ id: 'x', name: 'X', input: 'Y' }] }));
    expect(await loadAudioConfig(legacy)).toEqual({
      targetDb: -20,
      mics: [{ id: 'x', name: 'X', input: 'Y', channel: 'both', stream: true }],
    });
  });

  it('ignores a broken file and says why', async () => {
    const path = join(dir, 'audio.json');
    const logs: string[] = [];
    await writeFile(path, JSON.stringify({ mics: [{ id: 'a', name: 'A', input: 'x' }, { id: 'b', name: 'B', input: 'x' }] }));
    expect(await loadAudioConfig(path, (m) => logs.push(m))).toEqual({ targetDb: -20, mics: [] });
    expect(logs[0]).toMatch(/one mic only/);
  });

  it('derives unique ids from names', () => {
    expect(micIdFor('Guest Mic #1', new Set())).toBe('guest-mic-1');
    expect(micIdFor('Host', new Set(['host', 'host-2']))).toBe('host-3');
    expect(micIdFor('🎤', new Set())).toBe('mic');
  });
});
