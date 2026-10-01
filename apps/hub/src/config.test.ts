import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses defaults for missing or blank values', () => {
    expect(loadConfig({ HUB_PORT: '', OBS_WS_URL: '' })).toEqual({
      host: '127.0.0.1',
      port: 4747,
      obsUrl: 'ws://127.0.0.1:4455',
      obsPassword: '',
      dev: true,
    });
  });
  it('reads overrides', () => {
    const cfg = loadConfig({ HUB_PORT: '5000', OBS_WS_PASSWORD: 's3cret', NODE_ENV: 'production' });
    expect(cfg.port).toBe(5000);
    expect(cfg.obsPassword).toBe('s3cret');
    expect(cfg.dev).toBe(false);
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ HUB_PORT: '99999' })).toThrow();
  });
});
