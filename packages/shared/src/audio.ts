import { z } from 'zod';

export const MicIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes').max(40);

/** OBS has six audio tracks: track 1 carries the stream mix, 2–6 each carry one isolated mic. */
export const MIX_TRACK = 1;
export const ISOLATED_TRACKS = [2, 3, 4, 5, 6] as const;

/**
 * Which side of a stereo device a mic is on. Two-input interfaces and wireless kits in split
 * mode show up on macOS as one stereo device, one mic per side.
 */
export const MicChannelSchema = z.enum(['both', 'left', 'right']);
export type MicChannel = z.infer<typeof MicChannelSchema>;

export const MonitorSchema = z.enum(['off', 'monitor', 'both']);
export type Monitor = z.infer<typeof MonitorSchema>;

const Db = (min: number, max: number) => z.number().min(min).max(max);
const Ms = (min: number, max: number) => z.number().int().min(min).max(max);

/** Ranges match the OBS filter property pages. */
export const MicFilterSchemas = {
  gain: z.object({ enabled: z.boolean(), db: Db(-30, 30) }),
  denoise: z.object({ enabled: z.boolean(), method: z.enum(['rnnoise', 'speex']), suppressDb: Db(-60, 0) }),
  gate: z.object({
    enabled: z.boolean(),
    openDb: Db(-96, 0),
    closeDb: Db(-96, 0),
    attackMs: Ms(1, 10000),
    holdMs: Ms(1, 10000),
    releaseMs: Ms(1, 10000),
  }),
  eq: z.object({ enabled: z.boolean(), low: Db(-20, 20), mid: Db(-20, 20), high: Db(-20, 20) }),
  compressor: z.object({
    enabled: z.boolean(),
    ratio: z.number().min(1).max(32),
    thresholdDb: Db(-60, 0),
    attackMs: Ms(1, 500),
    releaseMs: Ms(1, 1000),
    outputDb: Db(-32, 32),
  }),
  limiter: z.object({ enabled: z.boolean(), thresholdDb: Db(-60, 0), releaseMs: Ms(1, 1000) }),
};
export type MicFilterKey = keyof typeof MicFilterSchemas;
/** Order of the chain in OBS: level first, clean up, shape, then control dynamics. */
export const MIC_FILTER_ORDER: MicFilterKey[] = ['gain', 'denoise', 'gate', 'eq', 'compressor', 'limiter'];

export const MicFiltersSchema = z.object(MicFilterSchemas);
export type MicFilters = z.infer<typeof MicFiltersSchema>;

export const MicFiltersPatchSchema = z
  .object({
    gain: MicFilterSchemas.gain.partial(),
    denoise: MicFilterSchemas.denoise.partial(),
    gate: MicFilterSchemas.gate.partial(),
    eq: MicFilterSchemas.eq.partial(),
    compressor: MicFilterSchemas.compressor.partial(),
    limiter: MicFilterSchemas.limiter.partial(),
  })
  .partial();
export type MicFiltersPatch = z.infer<typeof MicFiltersPatchSchema>;

export const SoundcheckSchema = z.object({
  state: z.enum(['listening', 'done', 'failed']),
  /** When listening ends (epoch ms). */
  until: z.number().optional(),
  /** Measured speech level before the change, dBFS. */
  measuredDb: z.number().optional(),
  /** Gain the sound check set, dB. */
  gainDb: z.number().optional(),
  detail: z.string().optional(),
});
export type Soundcheck = z.infer<typeof SoundcheckSchema>;

export const MicStateSchema = z.object({
  id: MicIdSchema,
  name: z.string(),
  /** The OBS input this mic is. */
  input: z.string(),
  channel: MicChannelSchema,
  /** Isolated recording track (2–6), or null when all isolated tracks are taken. */
  track: z.number().int().min(2).max(6).nullable(),
  /** ok: under control; missing: no such input in OBS; offline: OBS is not connected. */
  status: z.enum(['ok', 'missing', 'offline']),
  detail: z.string().optional(),
  /** Whether the input is in the program scene, i.e. the audience can hear it. */
  live: z.boolean(),
  volumeDb: z.number(),
  muted: z.boolean(),
  monitor: MonitorSchema,
  syncOffsetMs: z.number(),
  filters: MicFiltersSchema,
  soundcheck: SoundcheckSchema.optional(),
});
export type MicState = z.infer<typeof MicStateSchema>;

export const AudioStateSchema = z.object({
  mics: z.array(MicStateSchema).max(32),
  /** Speech level the sound check aims for, dBFS. */
  targetDb: z.number().min(-40).max(-6),
  /** Tracks OBS will record (1 = stream mix). */
  recordTracks: z.array(z.number().int().min(1).max(6)),
  /** Set when the recording tracks could not be configured. */
  recordDetail: z.string().optional(),
  /** OBS is recording: OBS reads track settings when a recording starts, so changes wait for the next one. */
  tracksPending: z.boolean(),
});
export type AudioState = z.infer<typeof AudioStateSchema>;

export const AudioDeviceSchema = z.object({ id: z.string(), name: z.string() });
export type AudioDevice = z.infer<typeof AudioDeviceSchema>;

/** Audio devices OBS can capture, and audio inputs that exist in OBS but are not mics yet. */
export const AudioDevicesSchema = z.object({
  devices: z.array(AudioDeviceSchema).max(100),
  inputs: z.array(z.string()).max(200),
  detail: z.string().optional(),
});
export type AudioDevices = z.infer<typeof AudioDevicesSchema>;

/** Live meter levels per mic id, dBFS (−100 is silence). Sent up to 15 times per second, never retained. */
export const AudioLevelsSchema = z.object({
  levels: z.record(MicIdSchema, z.object({ peakDb: z.number(), rmsDb: z.number() })),
});
export type AudioLevels = z.infer<typeof AudioLevelsSchema>;

export const MicPatchSchema = z.object({
  id: MicIdSchema,
  name: z.string().trim().min(1).max(60).optional(),
  volumeDb: Db(-100, 26).optional(),
  muted: z.boolean().optional(),
  monitor: MonitorSchema.optional(),
  syncOffsetMs: Ms(-950, 20000).optional(),
  filters: MicFiltersPatchSchema.optional(),
});
export type MicPatch = z.infer<typeof MicPatchSchema>;

export const MicAddSchema = z.object({
  name: z.string().trim().min(1).max(60),
  channel: MicChannelSchema.default('both'),
  /** A device to capture (the hub creates the OBS input), or an existing OBS input to adopt. */
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('device'), device: z.string().min(1).max(300) }),
    z.object({ kind: z.literal('input'), input: z.string().min(1).max(300) }),
  ]),
});
export type MicAdd = z.infer<typeof MicAddSchema>;
