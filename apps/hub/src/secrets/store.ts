import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StreamDestination } from '@streamhub/shared';

export type TwitchSecrets = { accessToken: string; refreshToken: string; userId: string; login: string };
export type YouTubeSecrets = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  channelTitle?: string;
};
/** X public (PKCE) client: no client secret exists. */
export type XSecrets = {
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userId?: string;
  username?: string;
};
export type ObsSecrets = { url: string; password: string };
export type Secrets = {
  twitch?: TwitchSecrets;
  youtube?: YouTubeSecrets;
  x?: XSecrets;
  obs?: ObsSecrets;
  destinations?: StreamDestination[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Local secrets file: owner-only permissions, atomic replace, serialized writes. Never log its contents. */
export class SecretsStore {
  private data: Secrets = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    await this.tightenPermissions();
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = {};
        return;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isPlainObject(parsed)) {
      this.data = parsed as Secrets;
    } else {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup);
      console.warn(`[secrets] unreadable secrets file moved to ${backup}; starting empty`);
      this.data = {};
    }
  }

  /** The file and its directory must stay owner-only; repair loose modes (e.g. after a manual copy). */
  private async tightenPermissions(): Promise<void> {
    try {
      const dir = dirname(this.path);
      if ((await stat(dir)).mode & 0o077) await chmod(dir, 0o700);
    } catch {
      // missing directory, or a platform without chmod
    }
    try {
      if ((await stat(this.path)).mode & 0o077) await chmod(this.path, 0o600);
    } catch {
      // missing file, or a platform without chmod
    }
  }

  get(): Secrets {
    return structuredClone(this.data);
  }

  update(fn: (current: Secrets) => Secrets): Promise<void> {
    const next = this.writing.then(async () => {
      const data = fn(structuredClone(this.data));
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        // O_EXCL so a planted temp file is never reused; owner-only from the first byte.
        const handle = await open(tmp, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(data, null, 2));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, this.path);
        // Best effort: flush the directory entry so the rename survives a crash too.
        const dir = await open(dirname(this.path), 'r').catch(() => null);
        await dir?.sync().finally(() => dir.close()).catch(() => {});
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      this.data = data;
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
