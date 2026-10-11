import { z } from 'zod';

/** Platforms that report follows, subs, cheers, tips or raids. X has none of these. */
export const AlertPlatformSchema = z.enum(['twitch', 'youtube', 'kick']);
export type AlertPlatform = z.infer<typeof AlertPlatformSchema>;

export const ALERT_KINDS = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'tip', 'raid'] as const;
export const AlertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKindSchema>;

/** One thing that happened on a platform, normalized. `sub` also covers a new YouTube membership. */
export const AlertSchema = z.object({
  /** `${platform}:${platform event id}`, so a replayed or duplicated event can be recognized. */
  id: z.string().min(1).max(200),
  kind: AlertKindSchema,
  platform: AlertPlatformSchema,
  user: z.object({
    id: z.string().max(100),
    name: z.string().max(100),
    avatarUrl: z.string().max(2000).optional(),
  }),
  /** cheer: bits. tip: money in whole units of `currency` (5.5 means 5.50). */
  amount: z.number().nonnegative().optional(),
  /** ISO 4217 code, tips only. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** How the platform writes the amount, e.g. "$5.00" or "¥500". */
  amountText: z.string().max(40).optional(),
  /** giftsub: subs gifted. raid: viewers brought. */
  count: z.number().int().nonnegative().optional(),
  /** resub: months subscribed in total. */
  months: z.number().int().positive().optional(),
  /** Twitch: "1", "2", "3" or "Prime". YouTube: the membership level name. */
  tier: z.string().max(100).optional(),
  message: z.string().max(1000).optional(),
  at: z.number(),
  /** Fired from the dashboard's test buttons; never counts toward a goal. */
  test: z.boolean().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

/** Sound files bundled with the alerts overlay. */
export const ALERT_SOUNDS = ['chime', 'pop', 'coin', 'fanfare', 'none'] as const;
export const AlertSoundSchema = z.enum(ALERT_SOUNDS);
export type AlertSound = z.infer<typeof AlertSoundSchema>;

export const AlertKindConfigSchema = z.object({
  enabled: z.boolean(),
  /** Placeholders: {user} {amount} {count} {months} {tier}. */
  template: z.string().trim().min(1).max(200),
  sound: AlertSoundSchema,
  volume: z.number().min(0).max(1),
  durationMs: z.number().int().min(2000).max(30_000),
  /** Smaller alerts are skipped: bits for cheers, money for tips, viewers for raids, subs for gifts. 0 shows all. */
  minAmount: z.number().nonnegative(),
});
export type AlertKindConfig = z.infer<typeof AlertKindConfigSchema>;

export const AlertsConfigSchema = z.object({
  paused: z.boolean(),
  kinds: z.object({
    follow: AlertKindConfigSchema,
    sub: AlertKindConfigSchema,
    resub: AlertKindConfigSchema,
    giftsub: AlertKindConfigSchema,
    cheer: AlertKindConfigSchema,
    tip: AlertKindConfigSchema,
    raid: AlertKindConfigSchema,
  }),
});
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;

const kind = (template: string, sound: AlertSound, durationMs = 6000): AlertKindConfig => ({
  enabled: true,
  template,
  sound,
  volume: 0.6,
  durationMs,
  minAmount: 0,
});

export const defaultAlertsConfig = (): AlertsConfig => ({
  paused: false,
  kinds: {
    follow: kind('{user} just followed!', 'pop', 5000),
    sub: kind('{user} just subscribed!', 'chime'),
    resub: kind('{user} subscribed for {months} months!', 'chime'),
    giftsub: kind('{user} gifted {count} subs!', 'fanfare', 8000),
    cheer: kind('{user} cheered {amount} bits!', 'coin'),
    tip: kind('{user} tipped {amount}!', 'coin', 8000),
    raid: kind('{user} is raiding with {count} viewers!', 'fanfare', 8000),
  },
});

/** The alert's size compared against `minAmount`. */
export function alertSize(alert: Alert): number {
  if (alert.kind === 'cheer' || alert.kind === 'tip') return alert.amount ?? 0;
  if (alert.kind === 'giftsub' || alert.kind === 'raid') return alert.count ?? 0;
  return 0;
}

function formatAmount(alert: Alert): string {
  if (alert.amountText) return alert.amountText;
  if (alert.amount === undefined) return '';
  if (!alert.currency) return alert.amount.toLocaleString('en-US');
  try {
    return alert.amount.toLocaleString('en-US', { style: 'currency', currency: alert.currency });
  } catch {
    return `${alert.amount} ${alert.currency}`;
  }
}

/** Fills a template. Unknown placeholders stay as typed so a typo is visible in the preview. */
export function renderAlertText(template: string, alert: Alert): string {
  const values: Record<string, string> = {
    user: alert.user.name,
    amount: formatAmount(alert),
    count: alert.count === undefined ? '' : alert.count.toLocaleString('en-US'),
    months: alert.months === undefined ? '' : String(alert.months),
    tier: alert.tier ?? '',
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole));
}

/** What the overlay plays. The hub sends one at a time and hides it after `durationMs`. */
export const AlertShowSchema = z.object({
  alert: AlertSchema,
  text: z.string().max(400),
  sound: AlertSoundSchema,
  volume: z.number().min(0).max(1),
  durationMs: z.number().int().positive(),
});
export type AlertShow = z.infer<typeof AlertShowSchema>;

export const AlertRecentSchema = z.object({
  /** Newest first. */
  alerts: z.array(AlertSchema).max(50),
  /** Alerts waiting for the one on screen to finish. */
  queued: z.number().int().nonnegative(),
});
export type AlertRecent = z.infer<typeof AlertRecentSchema>;

export const AlertKindPatchSchema = AlertKindConfigSchema.partial().extend({ kind: AlertKindSchema });

/** Totals a platform reports for the whole channel. YouTube rounds subscriber counts, so it marks them approximate. */
export const PlatformTotalsSchema = z.object({
  platform: AlertPlatformSchema,
  /** Twitch followers, or YouTube subscribers. */
  followers: z.number().int().nonnegative().optional(),
  /** Twitch paid subscribers. */
  subs: z.number().int().nonnegative().optional(),
  approximate: z.boolean().optional(),
});
export type PlatformTotals = z.infer<typeof PlatformTotalsSchema>;

export const GoalIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes').max(40);
export const GoalMetricSchema = z.enum(['followers', 'subs', 'tips']);
export type GoalMetric = z.infer<typeof GoalMetricSchema>;
/** `stream`: counts from when the stream starts. `total`: the channel's total (tips: since the goal was made). */
export const GoalScopeSchema = z.enum(['stream', 'total']);
export type GoalScope = z.infer<typeof GoalScopeSchema>;

const GoalFields = z.object({
  id: GoalIdSchema,
  label: z.string().trim().min(1).max(60),
  metric: GoalMetricSchema,
  scope: GoalScopeSchema,
  target: z.number().positive().max(1e9),
  /** Tips goals only: tips in other currencies are not counted. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'use a 3-letter currency code like USD')
    .optional(),
  platforms: z.array(AlertPlatformSchema).min(1).max(3),
});

export const GoalInputSchema = GoalFields.refine((g) => g.metric !== 'tips' || g.currency !== undefined, {
  message: 'a tips goal needs a currency',
  path: ['currency'],
});
export type GoalInput = z.infer<typeof GoalInputSchema>;

export const GoalStateSchema = GoalFields.extend({
  current: z.number().nonnegative(),
  /** Part of `current` comes from a rounded platform count. */
  approximate: z.boolean().optional(),
  detail: z.string().max(200).optional(),
});
export type GoalState = z.infer<typeof GoalStateSchema>;

export const GoalsStateSchema = z.object({ goals: z.array(GoalStateSchema).max(20) });
export type GoalsState = z.infer<typeof GoalsStateSchema>;
