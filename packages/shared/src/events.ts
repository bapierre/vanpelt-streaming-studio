import { z } from 'zod';
import {
  AudioDevicesSchema,
  AudioLevelsSchema,
  AudioStateSchema,
  MicAddSchema,
  MicIdSchema,
  MicPatchSchema,
} from './audio';
import { CameraDriverStateSchema, CameraIdSchema, CameraSetSchema, CameraStateSchema } from './cameras';

export const PlatformSchema = z.enum(['twitch', 'youtube', 'kick', 'x']);
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

/** An RTMP target the streamer pastes once (server URL + stream key). The key is a secret. */
export const StreamDestinationSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes').max(40),
  label: z.string().trim().min(1).max(60),
  server: z.string().trim().regex(/^rtmps?:\/\/\S+$/, 'use an rtmp:// or rtmps:// URL').max(500),
  key: z.string().trim().max(500),
});
export type StreamDestination = z.infer<typeof StreamDestinationSchema>;

/** What the platform itself reports about our livestream (independent of OBS). */
export const PlatformLiveSchema = z.object({
  platform: PlatformSchema,
  /** Is the platform receiving our video? `unknown` when the API does not expose it to us. */
  ingest: z.enum(['active', 'inactive', 'unknown']),
  broadcast: z.enum(['none', 'scheduled', 'running', 'ended']),
  viewers: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
  startedAt: z.number().optional(),
  detail: z.string().optional(),
});
export type PlatformLive = z.infer<typeof PlatformLiveSchema>;

export const ObsSourceSchema = z.object({ name: z.string(), visible: z.boolean() });
export type ObsSource = z.infer<typeof ObsSourceSchema>;

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
  'platform.live': PlatformLiveSchema,
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
  'obs.settings': z.object({ url: z.string(), passwordSet: z.boolean() }),
  'obs.sources.list': z.object({ scene: z.string(), sources: z.array(ObsSourceSchema) }),
  'obs.cmd.reconnect': Empty,
  'obs.cmd.refresh': Empty,
  'destinations.list': z.object({
    destinations: z.array(StreamDestinationSchema),
    inObs: z.string().nullable(),
    detail: z.string().optional(),
  }),
  'destinations.cmd.save': StreamDestinationSchema,
  'destinations.cmd.remove': z.object({ id: z.string().min(1) }),
  'destinations.cmd.useInObs': z.object({ id: z.string().min(1) }),
  'show.feature.set': z.object({ message: ChatMessageSchema }),
  'show.feature.clear': Empty,
  'connections.state': ConnectionStateSchema,
  'connections.cmd.connect': z.object({ platform: PlatformSchema }),
  'connections.cmd.disconnect': z.object({ platform: PlatformSchema }),
  'connections.cmd.setYoutubeClient': z.object({
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
  }),
  'connections.cmd.setXClient': z.object({ clientId: z.string().trim().min(1).max(200) }),
  /** Omit `password` to keep the saved one; an empty string means OBS has no password. */
  'connections.cmd.setObs': z.object({
    url: z.string().trim().regex(/^wss?:\/\/\S+$/, 'use a ws:// or wss:// URL').max(300),
    password: z.string().max(500).optional(),
  }),
  'camera.state': CameraStateSchema,
  'camera.cmd.take': z.object({ id: CameraIdSchema }),
  'camera.cmd.set': CameraSetSchema,
  'camera.driver.state': CameraDriverStateSchema,
  'camera.driver.cmd.set': CameraSetSchema,
  'audio.state': AudioStateSchema,
  'audio.levels': AudioLevelsSchema,
  'audio.devices': AudioDevicesSchema,
  'audio.cmd.set': MicPatchSchema,
  'audio.cmd.add': MicAddSchema,
  'audio.cmd.remove': z.object({ id: MicIdSchema }),
  'audio.cmd.soundcheck': z.object({
    id: MicIdSchema,
    action: z.enum(['start', 'cancel']),
    seconds: z.number().int().min(3).max(30).optional(),
  }),
  'audio.cmd.setTarget': z.object({ targetDb: z.number().min(-40).max(-6) }),
  'audio.cmd.listDevices': Empty,
  /** Put the mics scene into `scene`, or into every scene when omitted, so the mics are heard there. */
  'audio.cmd.nest': z.object({ scene: z.string().min(1).optional() }),
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
