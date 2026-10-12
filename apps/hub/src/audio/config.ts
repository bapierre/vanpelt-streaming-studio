import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MicChannelSchema, MicIdSchema } from '@streamhub/shared';
import { describeError } from '../util/errors';

export const MicConfigSchema = z.object({
  id: MicIdSchema,
  name: z.string().trim().min(1).max(60),
  /** OBS input name. */
  input: z.string().min(1),
  channel: MicChannelSchema.default('both'),
  /** Wired into the stream mix (track 1). Unwired mics still record to their isolated track. */
  stream: z.boolean().default(true),
});
export type MicConfig = z.infer<typeof MicConfigSchema>;

export const DEFAULT_TARGET_DB = -20;

export const AudioFileSchema = z.object({
  targetDb: z.number().min(-40).max(-6).default(DEFAULT_TARGET_DB),
  mics: z
    .array(MicConfigSchema)
    .max(32)
    .default([])
    .refine((l) => new Set(l.map((m) => m.id)).size === l.length, { message: 'mic ids must be unique' })
    .refine((l) => new Set(l.map((m) => m.input)).size === l.length, { message: 'each OBS input can be one mic only' }),
});
export type AudioConfig = z.infer<typeof AudioFileSchema>;

export const emptyAudioConfig = (): AudioConfig => ({ targetDb: DEFAULT_TARGET_DB, mics: [] });

/** A missing file means no mics; a broken file is logged and ignored so the hub still starts. */
export async function loadAudioConfig(path: string, log: (msg: string) => void = console.warn): Promise<AudioConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[audio] cannot read ${path}: ${describeError(err)}`);
    return emptyAudioConfig();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    log(`[audio] ${path} is not valid JSON: ${describeError(err)}`);
    return emptyAudioConfig();
  }
  const parsed = AudioFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    log(`[audio] ${path} is invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`);
    return emptyAudioConfig();
  }
  return parsed.data;
}

/** Saves can overlap (one per slider tick); each needs its own temp file or the renames collide. */
let tmpCounter = 0;

/** Writes are atomic (temp file + rename) so a crash never leaves a half-written config. */
export async function saveAudioConfig(path: string, cfg: AudioConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  await rename(tmp, path);
}

/** A unique slug for a new mic (or anything else named by the streamer), derived from its name. */
export function micIdFor(name: string, taken: ReadonlySet<string>, fallback = 'mic'): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || fallback;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
