import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * The desktop app bundles Exeldro's Audio Monitor plugin (GPLv2, unmodified; see
 * apps/desktop/scripts/fetch-audio-monitor.mjs) and passes its resource dir to the hub. On start,
 * the hub drops the plugin into OBS's per-user plugin folder when it is missing or older than the
 * bundled copy. A plugin the user installed themselves (no streamhub marker) is never touched.
 */
export const AUDIO_MONITOR_VERSION = '0.10.1';

export type PluginInstall = 'no-resource' | 'absent' | 'user-install' | 'current' | 'installed';

/** OBS's per-user config dir, parent of the plugins folder. */
export function obsConfigDir(env: NodeJS.ProcessEnv = process.env, os: string = platform(), home = homedir()): string {
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'obs-studio');
  if (os === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'obs-studio');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'obs-studio');
}

/** What the plugin looks like inside OBS's plugins folder, per platform. */
const destName = (os: string) => (os === 'darwin' ? 'audio-monitor.plugin' : 'audio-monitor');

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export async function installAudioMonitor(opts: {
  resourceDir?: string;
  configDir?: string;
  version?: string;
  os?: string;
  log?: (m: string) => void;
}): Promise<PluginInstall> {
  const log = opts.log ?? (() => {});
  if (!opts.resourceDir || !(await exists(opts.resourceDir))) return 'no-resource';
  const os = opts.os ?? platform();
  const version = opts.version ?? AUDIO_MONITOR_VERSION;
  const source = join(opts.resourceDir, destName(os));
  if (!(await exists(source))) {
    log(`[headsets] no bundled Audio Monitor for this platform in ${opts.resourceDir}`);
    return 'no-resource';
  }
  const configDir = opts.configDir ?? obsConfigDir(process.env, os);
  if (!(await exists(configDir))) {
    log('[headsets] OBS has not run yet on this machine; Audio Monitor installs on the next start after it has.');
    return 'absent';
  }
  const pluginsDir = join(configDir, 'plugins');
  const dest = join(pluginsDir, destName(os));
  const marker = join(pluginsDir, '.streamhub-audio-monitor.json');
  // undefined: no marker — a foreign install, leave it alone; null: our marker, but unreadable.
  let markerVersion: string | null | undefined;
  try {
    markerVersion = (JSON.parse(await readFile(marker, 'utf8')) as { version?: string }).version ?? null;
  } catch (err) {
    markerVersion = (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
  if (await exists(dest)) {
    if (markerVersion === undefined) {
      log('[headsets] Audio Monitor is already installed outside streamhub; leaving it alone.');
      return 'user-install';
    }
    if (markerVersion === version) return 'current';
  }
  await mkdir(pluginsDir, { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await cp(source, dest, { recursive: true });
  await writeFile(marker, JSON.stringify({ version }) + '\n');
  log(`[headsets] Audio Monitor ${version} installed into OBS; it loads on the next OBS start.`);
  return 'installed';
}
