import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CameraIdSchema, CameraRecordModeSchema } from '@streamhub/shared';
import { describeError } from '../util/errors';

export const CameraConfigSchema = z.object({
  id: CameraIdSchema,
  name: z.string().trim().min(1),
  /** Module id of the camera's driver; null means OBS-side controls only. */
  driver: z.string().regex(/^[a-z0-9-]+$/).nullable().default(null),
  scene: z.string().min(1),
  source: z.string().min(1),
  driverConfig: z.record(z.string(), z.unknown()).default({}),
  /** How this camera gets its own video file when OBS records. */
  record: CameraRecordModeSchema.default('obs'),
});
export type CameraConfig = z.infer<typeof CameraConfigSchema>;

export const CamerasFileSchema = z
  .array(CameraConfigSchema)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, { message: 'camera ids must be unique' });

/** A missing file means no cameras; a broken file is logged and ignored so the hub still starts. */
export async function loadCameras(path: string, log: (msg: string) => void = console.warn): Promise<CameraConfig[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log(`[cameras] cannot read ${path}: ${describeError(err)}`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    log(`[cameras] ${path} is not valid JSON: ${describeError(err)}`);
    return [];
  }
  const parsed = CamerasFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    log(`[cameras] ${path} is invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`);
    return [];
  }
  return parsed.data;
}
