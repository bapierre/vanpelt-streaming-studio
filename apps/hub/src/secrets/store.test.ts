import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsStore } from './store';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streamhub-secrets-'));
  path = join(dir, '.streamhub', 'secrets.json');
});

async function writeRaw(content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

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

  it.skipIf(process.platform === 'win32')('tightens loose file and directory permissions on load', async () => {
    await writeRaw(JSON.stringify({ twitch }));
    await chmod(path, 0o644);
    await chmod(dirname(path), 0o755);
    const store = new SecretsStore(path);
    await store.load();
    expect(store.get()).toEqual({ twitch });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
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
  it.each(['null', '[]', '42', '"text"'])('moves a non-object file (%s) aside and starts empty', async (content) => {
    await writeRaw(content);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SecretsStore(path);
    await store.load();
    expect(store.get()).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('.corrupt-'));
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
