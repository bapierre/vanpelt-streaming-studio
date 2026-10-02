import type { Platform } from '@streamhub/shared';
import type { Connector } from './types';

export class ConnectorManager {
  private readonly byPlatform = new Map<Platform, Connector>();

  constructor(connectors: Connector[]) {
    for (const c of connectors) this.byPlatform.set(c.platform, c);
  }

  startAll() {
    for (const c of this.byPlatform.values()) this.safeStart(c);
  }

  restart(platform: Platform) {
    const c = this.byPlatform.get(platform);
    if (!c) return;
    void c
      .stop()
      .then(() => this.safeStart(c))
      .catch((err) => console.error('[connectors] restart failed', err));
  }

  async halt(platform: Platform) {
    await this.byPlatform.get(platform)?.stop();
  }

  async stopAll() {
    await Promise.all([...this.byPlatform.values()].map((c) => c.stop()));
  }

  private safeStart(c: Connector) {
    try {
      c.start();
    } catch (err) {
      console.error(`[connectors] ${c.platform} failed to start`, err);
    }
  }
}
