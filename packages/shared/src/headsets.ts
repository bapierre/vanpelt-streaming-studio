import { z } from 'zod';
import { MicIdSchema } from './audio';

/** Where to get Exeldro's Audio Monitor plugin, which plays a source to any output device. */
export const AUDIO_MONITOR_URL = 'https://obsproject.com/forum/resources/audio-monitor.1186/';

export const HeadsetIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes').max(40);

/** The Audio Monitor plugin can only turn a signal down, so headset levels top out at 0 dB. */
export const HEADSET_MIN_DB = -60;
export const HEADSET_MAX_DB = 0;
const Level = z.number().min(HEADSET_MIN_DB).max(HEADSET_MAX_DB);

/** `mic:<micId>` for a mic, `obs:<inputName>` for any other OBS audio (music, guest calls, desktop sound). */
export const SourceKeySchema = z
  .string()
  .max(320)
  .regex(/^(mic:[a-z0-9-]+|obs:.+)$/, 'use mic:<id> or obs:<input name>');
export type SourceKey = z.infer<typeof SourceKeySchema>;

export const micSourceKey = (micId: string): SourceKey => `mic:${micId}`;
export const obsSourceKey = (input: string): SourceKey => `obs:${input}`;

export const HeadsetSendSchema = z.object({ on: z.boolean(), db: Level });
export type HeadsetSend = z.infer<typeof HeadsetSendSchema>;

/** An output can follow the stream wiring or another output live, instead of holding its own mix. */
export const MirrorSchema = z.union([z.literal('stream'), HeadsetIdSchema]);
export type Mirror = z.infer<typeof MirrorSchema>;

export const HeadsetStateSchema = z.object({
  id: HeadsetIdSchema,
  name: z.string(),
  /** Output device name, as the computer lists it. */
  device: z.string(),
  /** The mic of the person wearing it, so the dashboard can mark their own voice. */
  owner: MicIdSchema.nullable(),
  masterDb: Level,
  muted: z.boolean(),
  /** When set, this output plays the mirrored node's wiring; `sends` then holds the effective mix. */
  mirror: MirrorSchema.nullable(),
  /** ok: playing; no-plugin: Audio Monitor is not installed in OBS; offline: OBS is not connected. */
  status: z.enum(['ok', 'no-plugin', 'offline']),
  detail: z.string().optional(),
  sends: z.record(SourceKeySchema, HeadsetSendSchema),
});
export type HeadsetState = z.infer<typeof HeadsetStateSchema>;

export const HeadsetSourceSchema = z.object({
  key: SourceKeySchema,
  name: z.string(),
  /** camera: the audio of a camera's OBS source (e.g. a shotgun mic on the camera body). */
  kind: z.enum(['mic', 'camera', 'obs']),
  /** Where the sound comes from: the camera name, or the OBS input name. */
  detail: z.string().optional(),
  /** OBS is producing audio for it now. A camera source that is off-screen is silent. */
  live: z.boolean(),
});
export type HeadsetSource = z.infer<typeof HeadsetSourceSchema>;

/** A source's wiring into the stream mix (OBS track 1). `db` is the source's own fader. */
export const StreamSendSchema = z.object({ on: z.boolean(), db: z.number().min(-100).max(26) });
export type StreamSend = z.infer<typeof StreamSendSchema>;

export const HeadsetsStateSchema = z.object({
  /** Whether OBS has the Audio Monitor plugin; null until OBS has been asked. */
  plugin: z.boolean().nullable(),
  /** Output devices found on this computer. Empty when they cannot be listed; type the name instead. */
  outputs: z.array(z.string()).max(100),
  outputsDetail: z.string().optional(),
  /** Mics first, then camera audio, then other OBS audio. */
  sources: z.array(HeadsetSourceSchema).max(232),
  /** The stream column: what the audience hears, per source. */
  stream: z.record(SourceKeySchema, StreamSendSchema),
  /** Display-name overrides per source, set with headsets.cmd.renameSource. */
  labels: z.record(SourceKeySchema, z.string()),
  headsets: z.array(HeadsetStateSchema).max(16),
});
export type HeadsetsState = z.infer<typeof HeadsetsStateSchema>;

const Name = z.string().trim().min(1).max(60);
const Device = z.string().trim().min(1).max(300);

export const HeadsetAddSchema = z.object({ name: Name, device: Device, owner: MicIdSchema.nullable().default(null) });
export type HeadsetAdd = z.infer<typeof HeadsetAddSchema>;

export const HeadsetPatchSchema = z.object({
  id: HeadsetIdSchema,
  name: Name.optional(),
  device: Device.optional(),
  owner: MicIdSchema.nullable().optional(),
  masterDb: Level.optional(),
  muted: z.boolean().optional(),
  mirror: MirrorSchema.nullable().optional(),
});
export type HeadsetPatch = z.infer<typeof HeadsetPatchSchema>;

export const HeadsetSendPatchSchema = z.object({
  id: HeadsetIdSchema,
  source: SourceKeySchema,
  on: z.boolean().optional(),
  db: Level.optional(),
});
export type HeadsetSendPatch = z.infer<typeof HeadsetSendPatchSchema>;

/** Wire a non-mic source into the stream mix; `db` sets its OBS fader. Mics take audio.cmd.set instead. */
export const StreamSendPatchSchema = z.object({
  source: SourceKeySchema,
  on: z.boolean().optional(),
  db: z.number().min(-100).max(26).optional(),
});
export type StreamSendPatch = z.infer<typeof StreamSendPatchSchema>;

/** Display-name override for any source; the underlying mic or OBS input keeps its real name. Null clears it. */
export const RenameSourceSchema = z.object({ source: SourceKeySchema, name: Name.nullable() });
export type RenameSource = z.infer<typeof RenameSourceSchema>;
