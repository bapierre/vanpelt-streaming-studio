/* global process, console */
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { bundle } from './bundle.mjs';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const resources = join(desktop, 'resources');
const target = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error('Could not determine the Rust host target.');
const nodeBinary = join(
  desktop,
  'src-tauri/binaries',
  `streamhub-node-${target}${process.platform === 'win32' ? '.exe' : ''}`,
);

await mkdir(resources, { recursive: true });
await mkdir(dirname(nodeBinary), { recursive: true });
await bundle(join(root, 'apps/hub/src/main.ts'), join(resources, 'hub.mjs'));
await rm(join(resources, 'dashboard'), { recursive: true, force: true });
await cp(join(root, 'apps/dashboard/dist'), join(resources, 'dashboard'), { recursive: true });
await copyFile(
  join(root, 'apps/hub/src/connectors/youtube/stream_list.proto'),
  join(resources, 'stream_list.proto'),
);
await copyFile(process.execPath, nodeBinary);
await chmod(nodeBinary, 0o755);
console.log(
  `Prepared desktop resources for ${target}. Node ${process.versions.node} is bundled with the app.`,
);
