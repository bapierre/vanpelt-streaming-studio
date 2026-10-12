/* global process, console */
// Downloads Exeldro's Audio Monitor plugin (GPLv2, unmodified) into resources/audio-monitor so the
// desktop app can install it into OBS on first run. Pinned version + sha256; bump both together.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const VERSION = '0.10.1';
const RELEASE = `https://github.com/exeldro/obs-audio-monitor/releases/download/${VERSION}`;
const ASSETS = {
  macos: {
    file: `audio-monitor-${VERSION}-macos-universal.pkg`,
    sha256: '5d868be6985d0ce7dfbb77ba24ae8c006cb4b0ebc5326b7841efe972590a4f05',
  },
  windows: {
    file: `audio-monitor-${VERSION}-windows.zip`,
    sha256: '99a0419594e5affabdfd87accf716f0aaf33dd932f850c06f54145311be7b588',
  },
};
const LICENSE_URL = `https://raw.githubusercontent.com/exeldro/obs-audio-monitor/${VERSION}/LICENSE`;

const out = join(fileURLToPath(new URL('../resources/audio-monitor', import.meta.url)));
const platforms = process.argv.includes('--all')
  ? Object.keys(ASSETS)
  : [process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null].filter(Boolean);

if (platforms.length === 0) {
  console.log('No Audio Monitor bundle for this platform (Linux stays a manual install).');
  process.exit(0);
}

const tmp = await mkdtemp(join(tmpdir(), 'audio-monitor-'));
try {
  for (const platform of platforms) {
    const asset = ASSETS[platform];
    const archive = join(tmp, asset.file);
    execFileSync('curl', ['-sfL', '-o', archive, `${RELEASE}/${asset.file}`], { stdio: 'inherit' });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    if (digest !== asset.sha256) {
      throw new Error(`${asset.file}: sha256 ${digest} does not match the pinned ${asset.sha256}`);
    }
    const to = join(out, platform);
    await rm(to, { recursive: true, force: true });
    await mkdir(to, { recursive: true });
    if (platform === 'macos') {
      // The pkg is not installed; its payload is just unwrapped.
      execFileSync('pkgutil', ['--expand-full', archive, join(tmp, 'pkg')]);
      await cp(
        join(tmp, 'pkg/audio-monitor.pkg/Payload/Library/Application Support/obs-studio/plugins/audio-monitor.plugin'),
        join(to, 'audio-monitor.plugin'),
        { recursive: true },
      );
    } else {
      execFileSync('unzip', ['-q', archive, '-d', join(tmp, 'zip')]);
      // Program-dir layout becomes the user-level layout the hub installs into %APPDATA%.
      await mkdir(join(to, 'audio-monitor/bin/64bit'), { recursive: true });
      await cp(join(tmp, 'zip/obs-plugins/64bit/audio-monitor.dll'), join(to, 'audio-monitor/bin/64bit/audio-monitor.dll'));
      await cp(join(tmp, 'zip/data/obs-plugins/audio-monitor/locale'), join(to, 'audio-monitor/data/locale'), {
        recursive: true,
      });
    }
  }
  execFileSync('curl', ['-sfL', '-o', join(out, 'LICENSE'), LICENSE_URL], { stdio: 'inherit' });
  await writeFile(
    join(out, 'NOTICE.md'),
    `# Audio Monitor ${VERSION}

This app ships an UNMODIFIED copy of the Audio Monitor plugin for OBS
(https://github.com/exeldro/obs-audio-monitor), copyright Exeldro, licensed under the
GNU General Public License v2 (see LICENSE). It is a separate work aggregated with this
app; the app never links to or modifies it. Full source: the repository above, tag ${VERSION}.
`,
  );
  console.log(`Audio Monitor ${VERSION} ready in ${out} (${platforms.join(', ')}).`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
