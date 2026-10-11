import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { ModuleManifestSchema, type ModuleManifest, type ModulesList } from '@streamhub/shared';
import { describeError } from '../util/errors';

export type LoadedModule = { manifest: ModuleManifest; dir: string; webDir: string; token: string };

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

export type ServedFile =
  | { status: 200; type: string; body: Buffer | string; etag?: string; noStore?: boolean }
  | { status: 404; body: string };

/** Virtual per-module script that hands the page its session token (kept out of HTML so pages can run with `script-src 'self'`). */
export const SESSION_SCRIPT = '__session.js';

/**
 * Finds overlay modules (`modules/<id>/manifest.json` with `overlays`), serves their built pages
 * at `/m/<id>/` and hands each page a session token that identifies the module on the WebSocket.
 * Driver-only manifests (camera modules) are skipped here; the camera driver host loads those.
 */
export class ModuleHost {
  private constructor(private readonly modules: Map<string, LoadedModule>) {}

  static async discover(modulesDir: string, log: (msg: string) => void = console.warn): Promise<ModuleHost> {
    const found = new Map<string, LoadedModule>();
    let dirs: string[] = [];
    try {
      dirs = (await readdir(modulesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[modules] cannot read ${modulesDir}: ${describeError(err)}`);
    }
    for (const dirName of dirs.sort()) {
      const dir = join(modulesDir, dirName);
      let json: unknown;
      try {
        json = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      } catch {
        continue;
      }
      if (!json || typeof json !== 'object' || !('overlays' in json)) continue;
      const parsed = ModuleManifestSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        log(`[modules] skipping ${dirName}: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid manifest'}`);
        continue;
      }
      if (parsed.data.id !== dirName) {
        log(`[modules] skipping ${dirName}: its manifest id must be "${dirName}"`);
        continue;
      }
      found.set(dirName, {
        manifest: parsed.data,
        dir,
        webDir: join(dir, parsed.data.web),
        token: randomBytes(24).toString('hex'),
      });
    }
    return new ModuleHost(found);
  }

  get(id: string): LoadedModule | undefined {
    return this.modules.get(id);
  }

  /** The module's manifest when the token is the one its pages were served with. */
  authorize(id: string, token: string): ModuleManifest | null {
    const m = this.modules.get(id);
    if (!m) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(m.token);
    return a.length === b.length && timingSafeEqual(a, b) ? m.manifest : null;
  }

  list(baseUrl: string): ModulesList {
    return {
      modules: [...this.modules.values()].map((m) => ({
        id: m.manifest.id,
        name: m.manifest.name,
        version: m.manifest.version,
        built: m.manifest.overlays.some((o) => existsSync(join(m.webDir, o.path.split('?')[0]!))),
        overlays: m.manifest.overlays.map((o) => ({
          id: o.id,
          name: o.name ?? o.id,
          url: `${baseUrl}/m/${m.manifest.id}/${o.path}`,
          width: o.width,
          height: o.height,
        })),
      })),
    };
  }

  /** Reads a file of a module's built pages. Paths outside the module's web folder are not found. */
  async serve(id: string, path: string): Promise<ServedFile> {
    const m = this.modules.get(id);
    if (!m) return { status: 404, body: 'No such module' };
    const rel = path === '' || path.endsWith('/') ? `${path}index.html` : path;
    if (rel.split('/').some((part) => part === '..' || part === '' || part.startsWith('.'))) {
      return { status: 404, body: 'Not found' };
    }
    if (rel === SESSION_SCRIPT) {
      const body = `window.__STREAMHUB__=${JSON.stringify({ module: id, token: m.token })};`;
      return { status: 200, type: 'text/javascript; charset=utf-8', body, noStore: true };
    }
    let file: string;
    let root: string;
    try {
      root = await realpath(m.webDir);
      file = await realpath(join(m.webDir, rel));
    } catch {
      return existsSync(m.webDir)
        ? { status: 404, body: 'Not found' }
        : { status: 404, body: `The ${m.manifest.name} module is not built yet. Run pnpm build (or pnpm dev).` };
    }
    if (!file.startsWith(root + sep)) return { status: 404, body: 'Not found' };
    const ext = extname(file).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return { status: 404, body: 'Not found' };
    }
    // Assets revalidate against this ETag (Cache-Control: no-cache), so unchanged ones answer 304.
    // HTML is excluded: it references the session token and is served no-store.
    if (ext !== '.html') {
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
      return { status: 200, type, body, etag };
    }
    return { status: 200, type, body: injectSession(body.toString('utf8'), id), noStore: true };
  }
}

/**
 * The page loads `/m/<id>/__session.js`, which sets `window.__STREAMHUB__` for connecting as its
 * module. Pages on other origins cannot read it, and keeping the token out of the HTML lets module
 * pages run under `script-src 'self'`.
 */
export function injectSession(html: string, module: string): string {
  const script = `<script src="/m/${module}/${SESSION_SCRIPT}"></script>`;
  const head = html.match(/<head[^>]*>/i);
  if (!head) return `${script}${html}`;
  const at = head.index! + head[0].length;
  return `${html.slice(0, at)}${script}${html.slice(at)}`;
}
