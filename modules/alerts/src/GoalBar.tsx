import { useEffect, useState } from 'react';
import type { GoalState, GoalsState } from '@streamhub/shared';
import type { HubClient } from '@streamhub/overlay-sdk';

export function formatGoalValue(
  goal: Pick<GoalState, 'metric' | 'currency'>,
  value: number,
): string {
  if (goal.metric === 'tips' && goal.currency) {
    try {
      return value.toLocaleString('en-US', {
        style: 'currency',
        currency: goal.currency,
        maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
      });
    } catch {
      return `${value.toLocaleString('en-US')} ${goal.currency}`;
    }
  }
  return Math.floor(value).toLocaleString('en-US');
}

type Props = { hub: Pick<HubClient, 'on'>; goalId: string | null };

/** One goal, chosen with `?goal=<id>`. Without one, the first goal is shown. */
export function GoalBar({ hub, goalId }: Props) {
  const [goal, setGoal] = useState<GoalState | null>(null);

  useEffect(
    () =>
      hub.on('goal.state', (e) => {
        const { goals } = e.payload as GoalsState;
        setGoal((goalId ? goals.find((g) => g.id === goalId) : goals[0]) ?? null);
      }),
    [hub, goalId],
  );

  if (!goal) return null;
  const ratio = Math.min(1, goal.current / goal.target);
  const done = goal.current >= goal.target;
  return (
    <div className="stage goal-stage">
      <div className={`goal goal-${goal.metric}${done ? ' done' : ''}`}>
        <div className="goal-head">
          <span className="goal-label">{goal.label}</span>
          <span className="goal-count">
            {goal.approximate ? '~' : ''}
            {formatGoalValue(goal, goal.current)} / {formatGoalValue(goal, goal.target)}
          </span>
        </div>
        <div
          className="goal-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={goal.target}
          aria-valuenow={goal.current}
          aria-label={goal.label}
        >
          <div className="goal-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
