import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHeadsetsConfig, saveHeadsetsConfig, type HeadsetsConfig } from './config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-headsets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('headsets config', () => {
  it('starts empty without a file and round-trips what it saves', async () => {
    const path = join(dir, '.streamhub/headsets.json');
    expect(await loadHeadsetsConfig(path)).toEqual({ headsets: [] });
    const cfg: HeadsetsConfig = {
      headsets: [
        { id: 'cohost', name: 'Co-host', device: 'USB Audio', owner: 'cohost', masterDb: -6, muted: false, sends: { 'mic:host': { on: true, db: -3 } } },
      ],
    };
    await saveHeadsetsConfig(path, cfg);
    expect(await loadHeadsetsConfig(path)).toEqual(cfg);
    expect(await readFile(path, 'utf8')).toMatch(/\n$/);
  });

  it('fills in defaults for a hand-written headset', async () => {
    const path = join(dir, 'headsets.json');
    await writeFile(path, JSON.stringify({ headsets: [{ id: 'guest', name: 'Guest', device: 'USB Audio' }] }));
    expect((await loadHeadsetsConfig(path)).headsets[0]).toEqual({
      id: 'guest',
      name: 'Guest',
      device: 'USB Audio',
      owner: null,
      masterDb: 0,
      muted: false,
      sends: {},
    });
  });

  it('ignores a broken file and says why', async () => {
    const path = join(dir, 'headsets.json');
    const logs: string[] = [];
    const h = { id: 'a', name: 'A', device: 'X' };
    await writeFile(path, JSON.stringify({ headsets: [h, h] }));
    expect(await loadHeadsetsConfig(path, (m) => logs.push(m))).toEqual({ headsets: [] });
    expect(logs[0]).toMatch(/unique/);
  });
});
