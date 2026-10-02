import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ emitter: null as null | (EventEmitter & { cancel(): void }) }));

vi.mock('@grpc/grpc-js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@grpc/grpc-js')>();
  class FakeClient {
    StreamList() {
      const e = Object.assign(new EventEmitter(), { cancel: vi.fn() });
      calls.emitter = e;
      return e;
    }
    close() {}
  }
  return {
    ...real,
    loadPackageDefinition: () => ({ youtube: { api: { v3: { V3DataLiveChatMessageService: FakeClient } } } }),
    credentials: { createSsl: () => ({}) },
  };
});

const { createYouTubeApi } = await import('./api');

const setup = () => {
  const handlers = { onResponse: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
  const stream = createYouTubeApi().streamChat('tok', 'CHAT', undefined, handlers);
  return { handlers, stream, emitter: calls.emitter! };
};

describe('streamChat', () => {
  it('forwards normalized responses and end', () => {
    const { handlers, emitter } = setup();
    emitter.emit('data', { nextPageToken: 'n', items: [] });
    emitter.emit('end');
    expect(handlers.onResponse).toHaveBeenCalledTimes(1);
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('reports a malformed response through onError instead of throwing', () => {
    const { handlers, emitter } = setup();
    expect(() => emitter.emit('data', null)).not.toThrow();
    expect(handlers.onResponse).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'other' }));
  });

  it('has an error listener attached and maps gRPC errors', () => {
    const { handlers, emitter } = setup();
    expect(emitter.listenerCount('error')).toBe(1);
    emitter.emit('error', { code: 16, details: 'bad token' });
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'auth' }));
  });

  it('stays silent after cancel', () => {
    const { handlers, stream, emitter } = setup();
    stream.cancel();
    emitter.emit('error', { code: 1 });
    emitter.emit('end');
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });
});
