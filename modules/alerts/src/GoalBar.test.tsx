// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope, GoalState } from '@streamhub/shared';
import { formatGoalValue, GoalBar } from './GoalBar';

afterEach(cleanup);

function fakeHub() {
  let handler: ((e: Envelope) => void) | undefined;
  return {
    on(_topic: string, h: (e: Envelope) => void) {
      handler = h;
      return () => (handler = undefined);
    },
    goals(goals: GoalState[]) {
      act(() =>
        handler?.({
          v: 1,
          id: 'x',
          type: 'goal.state',
          ts: 0,
          source: 'hub:alerts',
          payload: { goals },
        } as Envelope),
      );
    },
  };
}

const goal = (over: Partial<GoalState>): GoalState =>
  ({
    id: 'followers',
    label: 'Follower goal',
    metric: 'followers',
    scope: 'stream',
    target: 100,
    platforms: ['twitch'],
    current: 25,
    ...over,
  }) as GoalState;

describe('formatGoalValue', () => {
  it('formats counts and money', () => {
    expect(formatGoalValue({ metric: 'followers' }, 12345.7)).toBe('12,345');
    expect(formatGoalValue({ metric: 'tips', currency: 'USD' }, 50)).toBe('$50');
    expect(formatGoalValue({ metric: 'tips', currency: 'USD' }, 12.5)).toBe('$12.50');
    expect(formatGoalValue({ metric: 'tips', currency: 'EUR' }, 3)).toBe('€3');
  });
});

describe('GoalBar', () => {
  it('shows the first goal when none is chosen', () => {
    const hub = fakeHub();
    render(<GoalBar hub={hub} goalId={null} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    hub.goals([goal({}), goal({ id: 'subs', label: 'Sub goal', metric: 'subs' })]);
    const bar = screen.getByRole('progressbar', { name: 'Follower goal' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('25 / 100')).toBeTruthy();
    expect((bar.firstChild as HTMLElement).style.width).toBe('25%');
  });

  it('shows the chosen goal, caps the fill and marks approximate counts', () => {
    const hub = fakeHub();
    const { container } = render(<GoalBar hub={hub} goalId="subs" />);
    hub.goals([
      goal({}),
      goal({
        id: 'subs',
        label: 'Sub goal',
        metric: 'subs',
        current: 1200,
        target: 1000,
        approximate: true,
      }),
    ]);
    const bar = screen.getByRole('progressbar', { name: 'Sub goal' });
    expect((bar.firstChild as HTMLElement).style.width).toBe('100%');
    expect(screen.getByText('~1,200 / 1,000')).toBeTruthy();
    expect(container.querySelector('.goal.done')).toBeTruthy();
  });

  it('disappears when its goal is removed', () => {
    const hub = fakeHub();
    render(<GoalBar hub={hub} goalId="tips" />);
    hub.goals([
      goal({
        id: 'tips',
        label: 'Tips',
        metric: 'tips',
        currency: 'USD',
        target: 200,
        current: 40,
      }),
    ]);
    expect(screen.getByText('$40 / $200')).toBeTruthy();
    hub.goals([]);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
