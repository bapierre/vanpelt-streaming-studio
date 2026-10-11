import {
  AlertKindConfigSchema,
  alertSize,
  renderAlertText,
  type Alert,
  type AlertKind,
  type AlertPlatform,
  type Envelope,
  type EventPayload,
  type GoalInput,
  type GoalState,
  type KnownEventType,
  type PlatformTotals,
  type StreamState,
} from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import { describeError } from '../util/errors';
import { realTimer, type Timer } from '../util/timer';
import type { AlertsFile, StoredGoal } from './config';

export type AlertServiceOptions = {
  bus: Bus;
  file: AlertsFile;
  save: (file: AlertsFile) => Promise<void>;
  timer?: Timer;
  now?: () => number;
  log?: (msg: string) => void;
};

/** Pause between two alerts so they never run into each other. */
export const ALERT_GAP_MS = 1000;
const MAX_QUEUE = 100;
const MAX_RECENT = 50;
const SEEN_LIMIT = 2000;
const SAVE_DELAY_MS = 1000;
/** A stream that starts again this soon after stopping (a crash, a dropped connection) keeps its counts. */
export const RESTART_GRACE_MS = 15 * 60_000;
const MAX_GOALS = 20;

type Queued = { alert: Alert; force: boolean };
type Totals = Pick<PlatformTotals, 'followers' | 'subs' | 'approximate'>;

const TEST_ALERTS: Record<AlertKind, Partial<Alert>> = {
  follow: {},
  sub: { tier: '1' },
  resub: { months: 12, tier: '1', message: 'Love the show!' },
  giftsub: { count: 5, tier: '1' },
  cheer: { amount: 500, message: 'Take my bits' },
  tip: { amount: 5, currency: 'USD', amountText: '$5.00', message: 'Great episode' },
  raid: { count: 42 },
};

/** How much an alert moves a goal: per stream (resubs count as subs this stream) and on the channel total. */
function goalDelta(goal: GoalInput, alert: Alert, scope: 'stream' | 'total'): number {
  if (alert.test || !goal.platforms.includes(alert.platform)) return 0;
  switch (goal.metric) {
    case 'followers':
      return alert.kind === 'follow' ? 1 : 0;
    case 'subs':
      if (alert.kind === 'sub') return 1;
      if (alert.kind === 'resub') return scope === 'stream' ? 1 : 0;
      if (alert.kind === 'giftsub') return alert.count ?? 1;
      return 0;
    case 'tips':
      return alert.kind === 'tip' && alert.currency === goal.currency ? (alert.amount ?? 0) : 0;
  }
}

const NAMES: Record<AlertPlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };

/**
 * Turns platform alerts into one overlay queue and keeps goals counting.
 * See ARCHITECTURE.md §12 and docs/alerts.md.
 */
export class AlertService {
  private file: AlertsFile;
  private readonly timer: Timer;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly seen = new Set<string>();
  private readonly recent: Alert[] = [];
  private readonly queue: Queued[] = [];
  private current: { id: string; handle: unknown } | null = null;
  private gap: unknown = null;
  private saveTimer: unknown = null;
  private testSeq = 0;
  private stream: StreamState | undefined;
  private readonly totals = new Map<AlertPlatform, Totals>();
  /** Alerts since each platform last reported its totals, so a total goal moves between refreshes. */
  private readonly sinceTotals = new Map<AlertPlatform, { followers: number; subs: number }>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: AlertServiceOptions) {
    this.file = structuredClone(opts.file);
    this.timer = opts.timer ?? realTimer;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
  }

  start() {
    this.stop();
    this.unsubscribe = this.opts.bus.subscribe(
      ['alert.event', 'alert.cmd.', 'goal.cmd.', 'platform.totals', 'obs.stream.state'],
      (e) => {
        try {
          this.handle(e);
        } catch (err) {
          this.log(`[alerts] failed to handle ${e.type}: ${describeError(err)}`);
        } finally {
          this.flushPublishes();
        }
      },
    );
    this.publishConfig();
    this.publishRecent();
    this.publishGoals();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const h of [this.current?.handle, this.gap]) if (h != null) this.timer.clear(h);
    this.current = null;
    this.gap = null;
    if (this.saveTimer !== null) {
      this.timer.clear(this.saveTimer);
      this.saveTimer = null;
      void this.flush();
    }
  }

  private handle(e: Envelope) {
    switch (e.type) {
      case 'alert.event':
        return this.onAlert(e.payload as Alert);
      case 'platform.totals':
        return this.onTotals(e.payload as PlatformTotals);
      case 'obs.stream.state':
        return this.onStreamState((e.payload as EventPayload<'obs.stream.state'>).state);
      case 'alert.cmd.test':
        return this.test((e.payload as EventPayload<'alert.cmd.test'>).kind);
      case 'alert.cmd.replay': {
        const alert = this.recent.find((a) => a.id === (e.payload as EventPayload<'alert.cmd.replay'>).id);
        if (alert) this.enqueue({ alert, force: true });
        return;
      }
      case 'alert.cmd.skip':
        return this.skip();
      case 'alert.cmd.pause':
        return this.setPaused((e.payload as EventPayload<'alert.cmd.pause'>).paused);
      case 'alert.cmd.setKind':
        return this.setKind(e.payload as EventPayload<'alert.cmd.setKind'>);
      case 'goal.cmd.save':
        return this.saveGoal(e.payload as GoalInput);
      case 'goal.cmd.remove':
        return this.removeGoal((e.payload as EventPayload<'goal.cmd.remove'>).id);
      case 'goal.cmd.reset':
        return this.resetGoal((e.payload as EventPayload<'goal.cmd.reset'>).id);
    }
  }

  private onAlert(alert: Alert) {
    if (this.seen.has(alert.id)) return;
    this.remember(alert.id);
    // Unfollowing and following again must not replay a follow alert.
    if (alert.kind === 'follow') {
      const key = `follow:${alert.platform}:${alert.user.id}`;
      if (this.seen.has(key)) return;
      this.remember(key);
    }
    this.recent.unshift(alert);
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
    this.count(alert);
    this.enqueue({ alert, force: false });
    this.publishSoon('recent');
  }

  private remember(key: string) {
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
  }

  private count(alert: Alert) {
    if (alert.test) return;
    let changed = false;
    for (const stored of this.file.goals) {
      const counted = stored.goal.scope === 'stream' || stored.goal.metric === 'tips';
      const delta = counted ? goalDelta(stored.goal, alert, stored.goal.scope) : 0;
      if (delta > 0) {
        stored.count += delta;
        changed = true;
      }
    }
    const since = this.sinceTotals.get(alert.platform) ?? { followers: 0, subs: 0 };
    if (alert.kind === 'follow') since.followers += 1;
    if (alert.kind === 'sub') since.subs += 1;
    if (alert.kind === 'giftsub') since.subs += alert.count ?? 1;
    this.sinceTotals.set(alert.platform, since);
    if (changed) this.saveSoon();
    this.publishSoon('goals');
  }

  private onTotals(t: PlatformTotals) {
    const prev = this.totals.get(t.platform) ?? {};
    const since = this.sinceTotals.get(t.platform) ?? { followers: 0, subs: 0 };
    // The fresh total already includes what happened since the last one.
    if (t.followers !== undefined) since.followers = 0;
    if (t.subs !== undefined) since.subs = 0;
    this.sinceTotals.set(t.platform, since);
    this.totals.set(t.platform, {
      followers: t.followers ?? prev.followers,
      subs: t.subs ?? prev.subs,
      approximate: t.approximate,
    });
    this.publishSoon('goals');
  }

  private onStreamState(state: StreamState) {
    const prev = this.stream;
    this.stream = state;
    // The retained state at startup (prev undefined) is not a transition.
    if (prev === undefined || prev === state) return;
    if (state === 'live' && (prev === 'starting' || prev === 'stopped')) {
      const ended = this.file.lastStreamEndedAt;
      if (ended === undefined || this.now() - ended > RESTART_GRACE_MS) {
        for (const g of this.file.goals) if (g.goal.scope === 'stream') g.count = 0;
        this.saveSoon();
        this.publishSoon('goals');
      }
    }
    if (state === 'stopped' && (prev === 'live' || prev === 'stopping')) {
      this.file.lastStreamEndedAt = this.now();
      this.saveSoon();
    }
  }

  private test(kind: AlertKind) {
    const alert: Alert = {
      id: `test:${++this.testSeq}`,
      kind,
      platform: kind === 'tip' ? 'youtube' : 'twitch',
      user: { id: 'test', name: kind === 'raid' ? 'A Friendly Streamer' : 'Test Viewer' },
      at: this.now(),
      test: true,
      ...TEST_ALERTS[kind],
    };
    this.recent.unshift(alert);
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
    this.enqueue({ alert, force: true });
    this.publishSoon('recent');
  }

  /** `force`: tests and replays play even when their kind is off or below the minimum. */
  private enqueue(item: Queued) {
    const cfg = this.file.config.kinds[item.alert.kind];
    if (!item.force && (!cfg.enabled || alertSize(item.alert) < cfg.minAmount)) return;
    this.queue.push(item);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.playNext();
  }

  private playNext() {
    if (this.current || this.gap !== null || this.file.config.paused) {
      this.publishSoon('recent');
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.publishSoon('recent');
      return;
    }
    const cfg = this.file.config.kinds[next.alert.kind];
    const id = next.alert.id;
    this.publish('alert.show', {
      alert: next.alert,
      text: renderAlertText(cfg.template, next.alert).slice(0, 400),
      sound: cfg.sound,
      volume: cfg.volume,
      durationMs: cfg.durationMs,
    });
    this.current = { id, handle: this.timer.set(() => this.finish(id), cfg.durationMs) };
    this.publishSoon('recent');
  }

  private finish(id: string) {
    if (this.current?.id !== id) return;
    this.current = null;
    this.publish('alert.hide', { id });
    this.gap = this.timer.set(() => {
      this.gap = null;
      this.playNext();
    }, ALERT_GAP_MS);
  }

  private skip() {
    if (!this.current) return;
    this.timer.clear(this.current.handle);
    this.finish(this.current.id);
  }

  private setPaused(paused: boolean) {
    if (this.file.config.paused === paused) return;
    this.file.config.paused = paused;
    this.saveSoon();
    this.publishConfig();
    if (!paused) this.playNext();
  }

  private setKind(patch: EventPayload<'alert.cmd.setKind'>) {
    const { kind, ...rest } = patch;
    const next = AlertKindConfigSchema.safeParse({ ...this.file.config.kinds[kind], ...rest });
    if (!next.success) return;
    this.file.config.kinds[kind] = next.data;
    this.saveSoon();
    this.publishConfig();
  }

  private saveGoal(goal: GoalInput) {
    const existing = this.file.goals.find((g) => g.goal.id === goal.id);
    if (existing) {
      const same =
        existing.goal.metric === goal.metric && existing.goal.scope === goal.scope && existing.goal.currency === goal.currency;
      existing.goal = goal;
      if (!same) existing.count = 0;
    } else {
      if (this.file.goals.length >= MAX_GOALS) return;
      this.file.goals.push({ goal, count: 0 });
    }
    this.saveSoon();
    this.publishSoon('goals');
  }

  private removeGoal(id: string) {
    const before = this.file.goals.length;
    this.file.goals = this.file.goals.filter((g) => g.goal.id !== id);
    if (this.file.goals.length === before) return;
    this.saveSoon();
    this.publishSoon('goals');
  }

  private resetGoal(id: string) {
    const stored = this.file.goals.find((g) => g.goal.id === id);
    if (!stored) return;
    stored.count = 0;
    this.saveSoon();
    this.publishSoon('goals');
  }

  goalState(stored: StoredGoal): GoalState {
    const { goal } = stored;
    if (goal.scope === 'stream' || goal.metric === 'tips') return { ...goal, current: stored.count };
    const metric = goal.metric;
    let current = 0;
    let approximate = false;
    const missing: string[] = [];
    for (const platform of goal.platforms) {
      const total = this.totals.get(platform)?.[metric];
      if (total === undefined) {
        missing.push(NAMES[platform]);
        continue;
      }
      current += total + (this.sinceTotals.get(platform)?.[metric] ?? 0);
      if (this.totals.get(platform)?.approximate) approximate = true;
    }
    const state: GoalState = { ...goal, current };
    if (approximate) state.approximate = true;
    if (missing.length) {
      state.detail =
        metric === 'subs' && missing.includes('YouTube')
          ? `YouTube does not share member counts${missing.length > 1 ? `; no count from ${missing.filter((m) => m !== 'YouTube').join(', ')} yet` : ''}`
          : `No ${metric === 'followers' ? 'follower' : 'sub'} count from ${missing.join(', ')} yet`;
    }
    return state;
  }

  private saveSoon() {
    if (this.saveTimer !== null) return;
    this.saveTimer = this.timer.set(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  private async flush() {
    try {
      await this.opts.save(structuredClone(this.file));
    } catch (err) {
      this.log(`[alerts] could not save alert settings: ${describeError(err)}`);
    }
  }

  private publishConfig() {
    this.publish('alert.config', this.file.config);
  }

  /** State changed several times inside one event (recent + goals + queue), so publishes flush once per event. */
  private pendingPublishes: Set<'recent' | 'goals'> | null = null;

  private publishSoon(kind: 'recent' | 'goals') {
    if (this.pendingPublishes) {
      this.pendingPublishes.add(kind);
      return;
    }
    this.pendingPublishes = new Set([kind]);
    // Timer paths (gap → playNext) never pass through the bus handler, so they flush here.
    queueMicrotask(() => this.flushPublishes());
  }

  private flushPublishes() {
    const pending = this.pendingPublishes;
    this.pendingPublishes = null;
    if (!pending) return;
    if (pending.has('recent')) this.publishRecent();
    if (pending.has('goals')) this.publishGoals();
  }

  private publishRecent() {
    this.publish('alert.recent', { alerts: this.recent, queued: this.queue.length });
  }

  private publishGoals() {
    this.publish('goal.state', { goals: this.file.goals.map((g) => this.goalState(g)) });
  }

  private publish<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    const result = this.opts.bus.publish({ type, payload, source: 'hub:alerts' });
    if (!result.ok) this.log(`[alerts] dropped invalid ${type}: ${result.error}`);
  }
}
