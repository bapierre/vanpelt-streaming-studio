import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAudioMonitor, obsConfigDir } from './plugin';

let dir: string;
let resource: string;
let config: string;
const logs: string[] = [];
const log = (m: string) => void logs.push(m);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-plugin-'));
  resource = join(dir, 'resources');
  config = join(dir, 'obs-studio');
  await mkdir(join(resource, 'audio-monitor.plugin', 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(resource, 'audio-monitor.plugin', 'Contents', 'MacOS', 'audio-monitor'), 'binary');
  await mkdir(join(config, 'plugins'), { recursive: true });
});
afterEach(async () => {
  logs.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const install = (over: Partial<Parameters<typeof installAudioMonitor>[0]> = {}) =>
  installAudioMonitor({ resourceDir: resource, configDir: config, log, ...over });

describe('obsConfigDir', () => {
  it('points at OBS’s per-user config dir per platform', () => {
    expect(obsConfigDir({}, 'darwin', '/home/u')).toBe('/home/u/Library/Application Support/obs-studio');
    expect(obsConfigDir({}, 'linux', '/home/u')).toBe('/home/u/.config/obs-studio');
    expect(obsConfigDir({ APPDATA: 'C:/Users/u/AppData/Roaming' }, 'win32', 'C:/Users/u')).toBe(
      'C:/Users/u/AppData/Roaming/obs-studio',
    );
  });
});

describe('installAudioMonitor', () => {
  it('does nothing without a bundled resource (a bare hub)', async () => {
    expect(await installAudioMonitor({ configDir: config, log })).toBe('no-resource');
  });

  it('installs the plugin and marks the version', async () => {
    expect(await install()).toBe('installed');
    const dest = join(config, 'plugins', 'audio-monitor.plugin');
    expect(await readFile(join(dest, 'Contents', 'MacOS', 'audio-monitor'), 'utf8')).toBe('binary');
    expect(JSON.parse(await readFile(join(config, 'plugins', '.streamhub-audio-monitor.json'), 'utf8'))).toEqual({
      version: expect.any(String),
    });
  });

  it('is a no-op once the bundled version is in place', async () => {
    await install();
    expect(await install()).toBe('current');
  });

  it('upgrades an older install of ours, but never a foreign one', async () => {
    const dest = join(config, 'plugins', 'audio-monitor.plugin');
    // Older streamhub install: replaced.
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'stale'), 'x');
    await writeFile(join(config, 'plugins', '.streamhub-audio-monitor.json'), JSON.stringify({ version: '0.0.1' }));
    expect(await install()).toBe('installed');
    expect(await readFile(join(dest, 'Contents', 'MacOS', 'audio-monitor'), 'utf8')).toBe('binary');
    // Foreign install (no marker): untouched.
    await rm(join(config, 'plugins', '.streamhub-audio-monitor.json'));
    await writeFile(join(dest, 'mine'), 'keep');
    expect(await install()).toBe('user-install');
    expect(await readFile(join(dest, 'mine'), 'utf8')).toBe('keep');
    expect(logs.some((l) => l.includes('leaving it alone'))).toBe(true);
  });

  it('reports absent when OBS has never run, and a corrupt marker counts as ours', async () => {
    await rm(config, { recursive: true });
    expect(await install()).toBe('absent');
    await mkdir(join(config, 'plugins', 'audio-monitor.plugin'), { recursive: true });
    await writeFile(join(config, 'plugins', '.streamhub-audio-monitor.json'), '{oops');
    expect(await install()).toBe('installed');
  });
});
