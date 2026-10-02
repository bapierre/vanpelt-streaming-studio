import { describe, expect, it, vi } from 'vitest';
import { ConnectorManager } from './manager';
import type { Connector } from './types';

const fake = (platform: 'twitch' | 'youtube'): Connector & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => ({
  platform,
  start: vi.fn(),
  stop: vi.fn(async () => {}),
}) as never;

describe('ConnectorManager', () => {
  it('starts all connectors and keeps going if one throws', () => {
    const a = fake('twitch');
    const b = fake('youtube');
    a.start.mockImplementation(() => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    new ConnectorManager([a, b]).startAll();
    expect(b.start).toHaveBeenCalled();
  });

  it('restarts one platform (stop, then start)', async () => {
    const a = fake('twitch');
    const m = new ConnectorManager([a, fake('youtube')]);
    m.restart('twitch');
    await vi.waitFor(() => expect(a.start).toHaveBeenCalled());
    expect(a.stop.mock.invocationCallOrder[0]).toBeLessThan(a.start.mock.invocationCallOrder[0]!);
  });

  it('ignores platforms without a connector', async () => {
    const m = new ConnectorManager([fake('youtube')]);
    m.restart('twitch');
    await expect(m.halt('kick')).resolves.toBeUndefined();
  });

  it('logs instead of rejecting when stop fails during a restart', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = fake('twitch');
    a.stop.mockRejectedValue(new Error('stop failed'));
    new ConnectorManager([a]).restart('twitch');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[connectors] restart failed', expect.any(Error)));
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(a.start).not.toHaveBeenCalled();
  });
});
