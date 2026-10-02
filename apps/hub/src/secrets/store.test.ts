import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from './store';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-secrets-'));
  path = join(dir, '.streamhub', 'secrets.json');
});

const twitch = { accessToken: 'a', refreshToken: 'r', userId: '1', login: 'yatf' };

describe('SecretsStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = new SecretsStore(path);
    await store.load();
    expect(store.get()).toEqual({});
  });

  it('persists updates and reloads them', async () => {
    const store = new SecretsStore(path);
    await store.load();
    await store.update((s) => ({ ...s, twitch }));
    const again = new SecretsStore(path);
    await again.load();
    expect(again.get()).toEqual({ twitch });
  });

  it.skipIf(process.platform === 'win32')('writes the file readable by the owner only', async () => {
    const store = new SecretsStore(path);
    await store.update((s) => ({ ...s, twitch }));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('applies concurrent updates in order', async () => {
    const store = new SecretsStore(path);
    await Promise.all([
      store.update((s) => ({ ...s, twitch })),
      store.update((s) => ({ ...s, youtube: { clientId: 'c', clientSecret: 's' } })),
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      twitch,
      youtube: { clientId: 'c', clientSecret: 's' },
    });
  });

  it('returns copies so callers cannot mutate stored secrets', async () => {
    const store = new SecretsStore(path);
    await store.update((s) => ({ ...s, twitch }));
    store.get().twitch!.accessToken = 'mutated';
    expect(store.get().twitch!.accessToken).toBe('a');
  });

  it('moves an unreadable file aside and starts empty', async () => {
    const store = new SecretsStore(path);
    await store.update((s) => ({ ...s, twitch }));
    await writeFile(path, '{ not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const again = new SecretsStore(path);
    await again.load();
    expect(again.get()).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('.corrupt-'));
  });
});
