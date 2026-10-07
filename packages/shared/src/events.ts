import { z } from 'zod';
import { CameraDriverStateSchema, CameraIdSchema, CameraSetSchema, CameraStateSchema } from './cameras';

export const PlatformSchema = z.enum(['twitch', 'youtube', 'kick']);
export type Platform = z.infer<typeof PlatformSchema>;

export const ChatAuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  color: z.string().optional(),
  roles: z.array(z.enum(['owner', 'moderator', 'vip', 'subscriber', 'member'])),
});

export const ChatFragmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('emote'), name: z.string(), url: z.string() }),
  z.object({ kind: z.literal('mention'), name: z.string() }),
  z.object({ kind: z.literal('link'), url: z.string() }),
]);

export const ChatMessageSchema = z.object({
  id: z.string(), // `${platform}:${platformMessageId}`
  platform: PlatformSchema,
  channel: z.string(),
  author: ChatAuthorSchema,
  text: z.string(),
  fragments: z.array(ChatFragmentSchema),
  sentAt: z.number(),
  raw: z.unknown().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ConnectorStatusSchema = z.enum(['disconnected', 'connecting', 'live', 'offline', 'error']);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const StreamStateSchema = z.enum(['starting', 'live', 'stopping', 'stopped']);
export type StreamState = z.infer<typeof StreamStateSchema>;

export const ConnectionStateSchema = z.object({
  platform: PlatformSchema,
  state: z.enum(['disconnected', 'pending', 'connected', 'error']),
  account: z.string().optional(),
  detail: z.string().optional(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  authUrl: z.string().optional(),
  clientConfigured: z.boolean().optional(),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

const Empty = z.object({}).strict();
const Connection = z.object({ connected: z.boolean(), detail: z.string().optional() });

export const EventSchemas = {
  'chat.message': ChatMessageSchema,
  'chat.deleted': z.object({ id: z.string() }),
  'chat.cleared': z.object({ platform: PlatformSchema, authorId: z.string().optional() }),
  'platform.status': z.object({
    platform: PlatformSchema,
    status: ConnectorStatusSchema,
    detail: z.string().optional(),
  }),
  'relay.connection': Connection,
  'obs.connection': Connection,
  'obs.scene.changed': z.object({ scene: z.string() }),
  'obs.scenes.list': z.object({ scenes: z.array(z.string()), current: z.string() }),
  'obs.stream.state': z.object({ state: StreamStateSchema, startedAt: z.number().optional() }),
  'obs.cmd.setScene': z.object({ scene: z.string().min(1) }),
  'obs.cmd.startStream': Empty,
  'obs.cmd.stopStream': Empty,
  'obs.cmd.setSourceVisible': z.object({
    scene: z.string().min(1),
    source: z.string().min(1),
    visible: z.boolean(),
  }),
  'show.feature.set': z.object({ message: ChatMessageSchema }),
  'show.feature.clear': Empty,
  'connections.state': ConnectionStateSchema,
  'connections.cmd.connect': z.object({ platform: PlatformSchema }),
  'connections.cmd.disconnect': z.object({ platform: PlatformSchema }),
  'connections.cmd.setYoutubeClient': z.object({
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
  }),
  'camera.state': CameraStateSchema,
  'camera.cmd.take': z.object({ id: CameraIdSchema }),
  'camera.cmd.set': CameraSetSchema,
  'camera.driver.state': CameraDriverStateSchema,
  'camera.driver.cmd.set': CameraSetSchema,
} as const;

export type KnownEventType = keyof typeof EventSchemas;
export type EventPayload<T extends KnownEventType> = z.infer<(typeof EventSchemas)[T]>;

const MODULE_EVENT = /^module\.[a-z0-9-]+\.[a-zA-Z0-9_.-]+$/;

export function isKnownEventType(type: string): type is KnownEventType {
  return Object.hasOwn(EventSchemas, type);
}

export function validatePayload(
  type: string,
  payload: unknown,
): { ok: true; payload: unknown } | { ok: false; error: string } {
  if (isKnownEventType(type)) {
    const result = EventSchemas[type].safeParse(payload);
    if (result.success) return { ok: true, payload: result.data };
    const error = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error };
  }
  if (MODULE_EVENT.test(type)) return { ok: true, payload };
  return { ok: false, error: `unknown event type: ${type}` };
}
