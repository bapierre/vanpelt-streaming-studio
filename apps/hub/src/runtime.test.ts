import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimePaths } from './runtime';

describe('runtimePaths', () => {
  it('keeps repo-relative paths for the web app', () => {
    const paths = runtimePaths({});
    expect(isAbsolute(paths.env)).toBe(true);
    expect(paths.env).toMatch(/[/\\]\.env$/);
    expect(paths.secrets).toMatch(/[/\\]\.streamhub[/\\]secrets\.json$/);
    expect(paths.dashboard).toMatch(/[/\\]apps[/\\]dashboard[/\\]dist$/);
    expect(paths.proto).toMatch(
      /[/\\]apps[/\\]hub[/\\]src[/\\]connectors[/\\]youtube[/\\]stream_list\.proto$/,
    );
  });

  it('separates writable desktop data from bundled resources', () => {
    expect(
      runtimePaths({
        STREAMHUB_DATA_DIR: '/app/data',
        STREAMHUB_DASHBOARD_DIR: '/app/resources/dashboard',
        STREAMHUB_PROTO_PATH: '/app/resources/stream_list.proto',
        STREAMHUB_MODULES_DIR: '/app/resources/modules',
      }),
    ).toEqual({
      env: join('/app/data', '.env'),
      secrets: join('/app/data', '.streamhub/secrets.json'),
      cameras: join('/app/data', '.streamhub/cameras.json'),
      audio: join('/app/data', '.streamhub/audio.json'),
      headsets: join('/app/data', '.streamhub/headsets.json'),
      alerts: join('/app/data', '.streamhub/alerts.json'),
      modules: '/app/resources/modules',
      dashboard: '/app/resources/dashboard',
      proto: '/app/resources/stream_list.proto',
    });
  });
});
