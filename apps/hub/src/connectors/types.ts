import type { Platform } from '@streamhub/shared';

export interface Connector {
  readonly platform: Platform;
  start(): void;
  stop(): Promise<void>;
}

/** The subset of a WebSocket client we use (the `ws` package satisfies it via a cast). */
export type SocketLike = {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
  close(code?: number): void;
};

export type SocketFactory = (url: string) => SocketLike;
