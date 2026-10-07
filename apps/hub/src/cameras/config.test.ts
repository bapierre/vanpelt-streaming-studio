import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCameras } from './config';

async function file(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cams-'));
  const path = join(dir, 'cameras.json');
  await writeFile(path, content);
  return path;
}

describe('loadCameras', () => {
  it('returns no cameras when the file does not exist', async () => {
    const logs: string[] = [];
    expect(await loadCameras('/nonexistent/cameras.json', (m) => logs.push(m))).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('fills defaults for an OBS-only camera', async () => {
    const path = await file(JSON.stringify([{ id: 'sony', name: 'Sony', scene: 'Sony', source: 'Cam' }]));
    expect(await loadCameras(path)).toEqual([
      { id: 'sony', name: 'Sony', driver: null, scene: 'Sony', source: 'Cam', driverConfig: {} },
    ]);
  });

  it('logs and ignores duplicate ids or broken JSON', async () => {
    const logs: string[] = [];
    const dup = await file(JSON.stringify([1, 2].map(() => ({ id: 'a', name: 'A', scene: 'S', source: 'C' }))));
    expect(await loadCameras(dup, (m) => logs.push(m))).toEqual([]);
    expect(await loadCameras(await file('{nope'), (m) => logs.push(m))).toEqual([]);
    expect(logs[0]).toContain('camera ids must be unique');
    expect(logs[1]).toContain('not valid JSON');
  });
});
