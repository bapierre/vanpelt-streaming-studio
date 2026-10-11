import { useState, type FormEvent } from 'react';
import type { GoalInput, GoalMetric, GoalScope, GoalState, ModulesList } from '@streamhub/shared';
import { alertsModule, ModuleNotice, OverlayUrl } from './AlertsPanel';

type GoalPlatform = 'twitch' | 'youtube';

const METRIC_LABELS: Record<GoalMetric, string> = {
  followers: 'Followers',
  subs: 'Subs',
  tips: 'Tips',
};
const PLATFORMS: Array<{ id: GoalPlatform; label: string }> = [
  { id: 'twitch', label: 'Twitch' },
  { id: 'youtube', label: 'YouTube' },
];
const MAX_GOALS = 20;
/** Platforms with no money alerts: Twitch bits are cheers, not tips. */
const NO_TIPS: GoalPlatform[] = ['twitch'];

export function scopeLabel(metric: GoalMetric, scope: GoalScope): string {
  if (scope === 'stream') return 'This stream';
  return metric === 'tips' ? 'Since the goal was made' : 'Channel total';
}

/** A short, unique id for a new goal, made from its label. */
export function goalId(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'goal';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function formatValue(goal: Pick<GoalState, 'metric' | 'currency'>, value: number): string {
  if (goal.metric === 'tips' && goal.currency) {
    try {
      return value.toLocaleString('en-US', {
        style: 'currency',
        currency: goal.currency,
        maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
      });
    } catch {
      return `${value} ${goal.currency}`;
    }
  }
  return Math.floor(value).toLocaleString('en-US');
}

type Draft = {
  label: string;
  metric: GoalMetric;
  scope: GoalScope;
  target: string;
  currency: string;
  platforms: GoalPlatform[];
};

const NEW_DRAFT: Draft = {
  label: '',
  metric: 'followers',
  scope: 'stream',
  target: '',
  currency: 'USD',
  platforms: ['twitch', 'youtube'],
};

function draftOf(goal: GoalState): Draft {
  return {
    label: goal.label,
    metric: goal.metric,
    scope: goal.scope,
    target: String(goal.target),
    currency: goal.currency ?? 'USD',
    platforms: goal.platforms.filter((p): p is GoalPlatform => p === 'twitch' || p === 'youtube'),
  };
}

function GoalForm({
  editing,
  taken,
  disabled,
  onSave,
  onCancel,
}: {
  editing: GoalState | null;
  taken: string[];
  disabled: boolean;
  onSave: (goal: GoalInput) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(editing ? draftOf(editing) : NEW_DRAFT);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const target = Number(d.target);
  const currency = d.currency.trim().toUpperCase();
  const platforms =
    d.metric === 'tips' ? d.platforms.filter((p) => !NO_TIPS.includes(p)) : d.platforms;
  const problem = !d.label.trim()
    ? 'Give the goal a name.'
    : !(target > 0)
      ? 'Set a target above 0.'
      : platforms.length === 0
        ? 'Pick at least one platform.'
        : d.metric === 'tips' && !/^[A-Z]{3}$/.test(currency)
          ? 'Use a 3-letter currency code like USD.'
          : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    onSave({
      id: editing?.id ?? goalId(d.label, taken),
      label: d.label.trim(),
      metric: d.metric,
      scope: d.scope,
      target,
      platforms,
      ...(d.metric === 'tips' ? { currency } : {}),
    });
    if (!editing) setD(NEW_DRAFT);
  };
  const resets =
    editing &&
    (editing.metric !== d.metric ||
      editing.scope !== d.scope ||
      (d.metric === 'tips' && editing.currency !== currency));

  return (
    <form
      className="group-row form"
      aria-label={editing ? `Edit ${editing.label}` : 'New goal'}
      onSubmit={submit}
    >
      <strong>{editing ? `Edit ${editing.label}` : 'New goal'}</strong>
      <div className="control">
        <label htmlFor="goal-label">Name</label>
        <input
          id="goal-label"
          className="alert-template"
          value={d.label}
          maxLength={60}
          placeholder="Road to 100 followers"
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>
      <div className="control">
        <label htmlFor="goal-metric">Counts</label>
        <select
          id="goal-metric"
          value={d.metric}
          onChange={(e) => set({ metric: e.target.value as GoalMetric })}
        >
          {(Object.keys(METRIC_LABELS) as GoalMetric[]).map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m]}
            </option>
          ))}
        </select>
        <select
          aria-label="Counted from"
          value={d.scope}
          onChange={(e) => set({ scope: e.target.value as GoalScope })}
        >
          {(['stream', 'total'] as GoalScope[]).map((s) => (
            <option key={s} value={s}>
              {scopeLabel(d.metric, s)}
            </option>
          ))}
        </select>
        <span className="small muted control-help">
          {d.metric === 'followers' &&
            'YouTube subscribers count as followers. YouTube rounds its total, so channel totals are marked ~.'}
          {d.metric === 'subs' &&
            'Twitch subs and YouTube memberships. YouTube does not share a member total, so channel totals use Twitch only.'}
          {d.metric === 'tips' &&
            'Super Chats and Super Stickers. Only tips in the goal’s currency count.'}
        </span>
      </div>
      <div className="control">
        <label htmlFor="goal-target">Target</label>
        <input
          id="goal-target"
          className="alert-number"
          type="number"
          min={1}
          step="any"
          value={d.target}
          onChange={(e) => set({ target: e.target.value })}
        />
        {d.metric === 'tips' && (
          <input
            aria-label="Currency"
            className="alert-currency"
            value={d.currency}
            maxLength={3}
            onChange={(e) => set({ currency: e.target.value })}
          />
        )}
      </div>
      <fieldset className="control goal-platforms">
        <legend className="small muted">Platforms</legend>
        {PLATFORMS.map((p) => (
          <label key={p.id} className="alert-toggle">
            <input
              type="checkbox"
              checked={platforms.includes(p.id)}
              disabled={d.metric === 'tips' && NO_TIPS.includes(p.id)}
              onChange={(e) =>
                set({
                  platforms: e.target.checked
                    ? [...d.platforms, p.id]
                    : d.platforms.filter((x) => x !== p.id),
                })
              }
            />
            {p.label}
          </label>
        ))}
        {d.metric === 'tips' && (
          <span className="small muted control-help">Twitch has no tips. Bits show as cheers.</span>
        )}
      </fieldset>
      {resets && (
        <p className="small muted">Changing what the goal counts starts it again from 0.</p>
      )}
      <div className="form-actions">
        {problem && d.label && <span className="small muted">{problem}</span>}
        {editing && (
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={disabled || problem !== null}>
          {editing ? 'Save' : 'Add goal'}
        </button>
      </div>
    </form>
  );
}

export type GoalActions = {
  onSave: (goal: GoalInput) => void;
  onRemove: (id: string) => void;
  onReset: (id: string) => void;
};

export function GoalsPanel({
  goals,
  modules,
  disabled,
  actions,
}: {
  goals: GoalState[] | null;
  modules: ModulesList | null;
  disabled: boolean;
  actions: GoalActions;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const overlay = alertsModule(modules)?.overlays.find((o) => o.id === 'goal');
  const editingGoal = goals?.find((g) => g.id === editing) ?? null;
  const off = disabled || !goals;
  return (
    <>
      <p className="muted small">
        Each goal has its own bar. Add one Browser Source per goal in OBS with the URL next to it.
      </p>
      <ModuleNotice modules={modules} />
      {goals && goals.length > 0 && (
        <section className="group">
          {goals.map((g) => (
            <div key={g.id} className="group-row form" data-testid={`goal-${g.id}`}>
              <div className="destination-head">
                <strong>{g.label}</strong>
                <span className="small muted">
                  {g.approximate ? '~' : ''}
                  {formatValue(g, g.current)} / {formatValue(g, g.target)}
                </span>
                <span className="spacer" />
                {(g.scope === 'stream' || g.metric === 'tips') && (
                  <button type="button" disabled={off} onClick={() => actions.onReset(g.id)}>
                    Reset
                  </button>
                )}
                <button type="button" disabled={off} onClick={() => setEditing(g.id)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={off}
                  onClick={() => actions.onRemove(g.id)}
                >
                  Remove
                </button>
              </div>
              <div
                className="meter"
                role="progressbar"
                aria-label={g.label}
                aria-valuemin={0}
                aria-valuemax={g.target}
                aria-valuenow={g.current}
              >
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, (g.current / g.target) * 100)}%` }}
                />
              </div>
              <span className="small muted">
                {METRIC_LABELS[g.metric]} · {scopeLabel(g.metric, g.scope)} ·{' '}
                {g.platforms
                  .map((p) => (p === 'youtube' ? 'YouTube' : p === 'twitch' ? 'Twitch' : 'Kick'))
                  .join(' and ')}
                {g.detail ? ` · ${g.detail}` : ''}
              </span>
              {overlay && (
                <OverlayUrl
                  name={`${g.label} bar`}
                  url={`${overlay.url}?goal=${g.id}`}
                  width={overlay.width}
                  height={overlay.height}
                />
              )}
            </div>
          ))}
        </section>
      )}
      {goals && goals.length === 0 && <p className="muted small">No goals yet.</p>}
      {!goals && <p className="muted small">Waiting for the hub.</p>}
      <section className="group">
        {editingGoal ? (
          <GoalForm
            key={editingGoal.id}
            editing={editingGoal}
            taken={[]}
            disabled={off}
            onSave={(g) => {
              actions.onSave(g);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (goals?.length ?? 0) < MAX_GOALS ? (
          <GoalForm
            key="new"
            editing={null}
            taken={goals?.map((g) => g.id) ?? []}
            disabled={off}
            onSave={actions.onSave}
            onCancel={() => {}}
          />
        ) : (
          <p className="group-row small muted">You have the most goals allowed ({MAX_GOALS}).</p>
        )}
      </section>
    </>
  );
}
