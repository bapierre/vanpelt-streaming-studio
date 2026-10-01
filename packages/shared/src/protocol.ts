import { z } from 'zod';
import type { Envelope } from './envelope';

const Topics = z.array(z.string().min(1)).max(50);

export const ClientOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), topics: Topics }),
  z.object({ op: z.literal('unsubscribe'), topics: Topics }),
  z.object({
    op: z.literal('publish'),
    event: z.object({ type: z.string().min(1), payload: z.unknown() }),
  }),
  z.object({
    op: z.literal('history'),
    reqId: z.string().min(1),
    topic: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
  }),
]);
export type ClientOp = z.input<typeof ClientOpSchema>;

export type ErrorCode = 'bad_json' | 'bad_op' | 'bad_payload' | 'forbidden';

export type ServerMessage =
  | Envelope
  | { op: 'error'; code: ErrorCode; message: string }
  | { op: 'history-result'; reqId: string; events: Envelope[] };
