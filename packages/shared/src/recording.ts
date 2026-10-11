import { z } from 'zod';
import { CameraIdSchema } from './cameras';

/** Where a camera's own video file comes from: OBS (Source Record filter), the camera's card, both, or nowhere. */
export const CameraRecordModeSchema = z.enum(['obs', 'card', 'both', 'off']);
export type CameraRecordMode = z.infer<typeof CameraRecordModeSchema>;

export const IsoStatusSchema = z.enum(['ready', 'recording', 'offline', 'no-plugin', 'no-source', 'error']);
export type IsoStatus = z.infer<typeof IsoStatusSchema>;

export const CardStatusSchema = z.enum(['ready', 'recording', 'unsupported', 'offline', 'error']);
export type CardStatus = z.infer<typeof CardStatusSchema>;

export const CameraRecordingSchema = z.object({
  id: CameraIdSchema,
  name: z.string(),
  mode: CameraRecordModeSchema,
  /** Present when `mode` is `obs` or `both`. */
  iso: IsoStatusSchema.optional(),
  /** Present when `mode` is `card` or `both`. */
  card: CardStatusSchema.optional(),
  detail: z.string().optional(),
});
export type CameraRecording = z.infer<typeof CameraRecordingSchema>;

export const RecordedFileSchema = z.object({
  kind: z.enum(['program', 'camera', 'card']),
  cameraId: CameraIdSchema.optional(),
  label: z.string(),
  /** A path on this computer, or a description of where the file is (e.g. a camera's card). */
  location: z.string(),
});
export type RecordedFile = z.infer<typeof RecordedFileSchema>;

export const DiskSpaceSchema = z.object({
  path: z.string(),
  freeBytes: z.number().nonnegative(),
  level: z.enum(['ok', 'low', 'critical']),
  /** Estimated from how fast the files are growing; only while recording. */
  minutesLeft: z.number().nonnegative().optional(),
});
export type DiskSpace = z.infer<typeof DiskSpaceSchema>;

export const RecordingOutputSchema = z.enum(['stopped', 'starting', 'recording', 'paused', 'stopping']);
export type RecordingOutput = z.infer<typeof RecordingOutputSchema>;

/** The whole recording session: OBS's program recording plus every camera's own file. */
export const RecordingSessionSchema = z.object({
  output: RecordingOutputSchema,
  startedAt: z.number().optional(),
  /** OBS's recording folder. */
  directory: z.string().optional(),
  cameras: z.array(CameraRecordingSchema).max(32),
  disk: DiskSpaceSchema.optional(),
  lastSession: z
    .object({ endedAt: z.number(), files: z.array(RecordedFileSchema).max(100) })
    .optional(),
  detail: z.string().optional(),
});
export type RecordingSession = z.infer<typeof RecordingSessionSchema>;
