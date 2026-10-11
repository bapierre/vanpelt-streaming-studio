import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AlertsConfigSchema, defaultAlertsConfig, GoalInputSchema } from '@streamhub/shared';
import { describeError } from '../util/errors';

export const StoredGoalSchema = z.object({
  goal: GoalInputSchema,
  /** `stream` goals: the count this stream. `total` tips goals: tips since the goal was made or reset. */
  count: z.number().nonnegative().default(0),
});
export type StoredGoal = z.infer<typeof StoredGoalSchema>;

/** Fills in kinds added after the file was written, so new alert kinds never invalidate old settings. */
function withDefaultKinds(value: unknown): unknown {
  if (value === undefined) return defaultAlertsConfig();
  if (!value || typeof value !== 'object') return value;
  const v = value as { kinds?: unknown };
  const defaults = defaultAlertsConfig();
  const kinds = v.kinds && typeof v.kinds === 'object' ? (v.kinds as Record<string, unknown>) : {};
  return { ...defaults, ...v, kinds: { ...defaults.kinds, ...kinds } };
}

export const AlertsFileSchema = z.object({
  config: z.preprocess(withDefaultKinds, AlertsConfigSchema),
  goals: z
    .array(StoredGoalSchema)
    .max(20)
    .default([])
    .refine((l) => new Set(l.map((g) => g.goal.id)).size === l.length, { message: 'goal ids must be unique' }),
  /** When the last stream stopped, so a quick restart after a crash keeps this stream's counts. */
  lastStreamEndedAt: z.number().optional(),
});
export type AlertsFile = z.infer<typeof AlertsFileSchema>;

export const emptyAlertsFile = (): AlertsFile => ({ config: defaultAlertsConfig(), goals: [] });

/** A missing file means defaults; a broken file is logged and ignored so the hub still starts. */
export async function loadAlertsFile(path: string, log: (msg: string) => void = console.warn): Promise<AlertsFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[alerts] cannot read ${path}: ${describeError(err)}`);
    return emptyAlertsFile();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    log(`[alerts] ${path} is not valid JSON: ${describeError(err)}`);
    return emptyAlertsFile();
  }
  const parsed = AlertsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    log(`[alerts] ${path} is invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`);
    return emptyAlertsFile();
  }
  return parsed.data;
}

/** Saves can overlap; each needs its own temp file or the renames collide. */
let tmpCounter = 0;

/** Atomic (temp file + rename) so a crash never leaves a half-written file. */
export async function saveAlertsFile(path: string, file: AlertsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
  await rename(tmp, path);
}
