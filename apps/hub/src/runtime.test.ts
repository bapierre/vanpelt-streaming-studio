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
      }),
    ).toEqual({
      env: join('/app/data', '.env'),
      secrets: join('/app/data', '.streamhub/secrets.json'),
      dashboard: '/app/resources/dashboard',
      proto: '/app/resources/stream_list.proto',
    });
  });
});
