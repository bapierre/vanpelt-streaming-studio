import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TwitchSecrets = { accessToken: string; refreshToken: string; userId: string; login: string };
export type YouTubeSecrets = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  channelTitle?: string;
};
export type Secrets = { twitch?: TwitchSecrets; youtube?: YouTubeSecrets };

/** Local secrets file: owner-only permissions, atomic replace, serialized writes. Never log its contents. */
export class SecretsStore {
  private data: Secrets = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
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
    try {
      this.data = JSON.parse(text) as Secrets;
    } catch {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup);
      console.warn(`[secrets] unreadable secrets file moved to ${backup}; starting empty`);
      this.data = {};
    }
  }

  get(): Secrets {
    return structuredClone(this.data);
  }

  update(fn: (current: Secrets) => Secrets): Promise<void> {
    const next = this.writing.then(async () => {
      const data = fn(structuredClone(this.data));
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
      this.data = data;
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
