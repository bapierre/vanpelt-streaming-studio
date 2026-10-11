import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { HEADSET_MAX_DB, HEADSET_MIN_DB, HeadsetIdSchema, HeadsetSendSchema, MicIdSchema, SourceKeySchema } from '@streamhub/shared';
import { describeError } from '../util/errors';

export const HeadsetConfigSchema = z.object({
  id: HeadsetIdSchema,
  name: z.string().trim().min(1).max(60),
  device: z.string().trim().min(1).max(300),
  owner: MicIdSchema.nullable().default(null),
  masterDb: z.number().min(HEADSET_MIN_DB).max(HEADSET_MAX_DB).default(0),
  muted: z.boolean().default(false),
  sends: z.record(SourceKeySchema, HeadsetSendSchema).default({}),
});
export type HeadsetConfig = z.infer<typeof HeadsetConfigSchema>;

export const HeadsetsFileSchema = z.object({
  headsets: z
    .array(HeadsetConfigSchema)
    .max(16)
    .default([])
    .refine((l) => new Set(l.map((h) => h.id)).size === l.length, { message: 'headset ids must be unique' }),
});
export type HeadsetsConfig = z.infer<typeof HeadsetsFileSchema>;

export const emptyHeadsetsConfig = (): HeadsetsConfig => ({ headsets: [] });

/** A missing file means no headsets; a broken file is logged and ignored so the hub still starts. */
export async function loadHeadsetsConfig(path: string, log: (msg: string) => void = console.warn): Promise<HeadsetsConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[headsets] cannot read ${path}: ${describeError(err)}`);
    return emptyHeadsetsConfig();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    log(`[headsets] ${path} is not valid JSON: ${describeError(err)}`);
    return emptyHeadsetsConfig();
  }
  const parsed = HeadsetsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    log(`[headsets] ${path} is invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`);
    return emptyHeadsetsConfig();
  }
  return parsed.data;
}

/** Writes are atomic (temp file + rename) so a crash never leaves a half-written config. */
export async function saveHeadsetsConfig(path: string, cfg: HeadsetsConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  await rename(tmp, path);
}
