import { connect, type HubClient } from '@streamhub/overlay-sdk';

declare global {
  interface Window {
    /** Injected by the hub into every module page it serves. */
    __STREAMHUB__?: { module: string; token: string };
  }
}

/** Connects as the alerts module, or returns null when the page was not opened from the hub. */
export function connectHub(): HubClient | null {
  const session = window.__STREAMHUB__;
  if (!session) {
    console.warn('[alerts] open this page from the hub (http://127.0.0.1:4747/m/alerts/...)');
    return null;
  }
  return connect({ module: session.module, token: session.token });
}
