import { connect, reconnectByReload, type HubClient } from '@streamhub/overlay-sdk';

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
    console.warn('[alerts] open this page from the hub (http://127.0.0.1:4748/m/alerts/...)');
    return null;
  }
  const hub = connect({ module: session.module, token: session.token });
  // A hub restart mints a new module token; this page still holds the old one, so every
  // reconnect is refused. Reload once to pick up the fresh token instead of dying silently.
  reconnectByReload(hub);
  return hub;
}
