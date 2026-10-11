// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalState, ModulesList } from '@streamhub/shared';
import { goalId, GoalsPanel, type GoalActions } from './GoalsPanel';

afterEach(cleanup);

const modules: ModulesList = {
  modules: [
    {
      id: 'alerts',
      name: 'Alerts and goals',
      version: '0.1.0',
      built: true,
      overlays: [
        {
          id: 'goal',
          name: 'Goal bar',
          url: 'http://127.0.0.1:4747/m/alerts/goal.html',
          width: 1920,
          height: 1080,
        },
      ],
    },
  ],
};

const followers: GoalState = {
  id: 'followers',
  label: 'Follower goal',
  metric: 'followers',
  scope: 'total',
  target: 5000,
  platforms: ['twitch', 'youtube'],
  current: 4200,
  approximate: true,
};
const tips: GoalState = {
  id: 'tips',
  label: 'Mic fund',
  metric: 'tips',
  scope: 'stream',
  target: 200,
  currency: 'USD',
  platforms: ['youtube'],
  current: 45.5,
};

function actions(): GoalActions & Record<string, ReturnType<typeof vi.fn>> {
  return { onSave: vi.fn(), onRemove: vi.fn(), onReset: vi.fn() };
}

describe('goalId', () => {
  it('slugs the label and avoids taken ids', () => {
    expect(goalId('Road to 100 Followers!', [])).toBe('road-to-100-followers');
    expect(goalId('Subs', ['subs', 'subs-2'])).toBe('subs-3');
    expect(goalId('!!!', [])).toBe('goal');
  });
});

describe('GoalsPanel', () => {
  it('shows each goal with its progress and its own OBS URL', () => {
    render(
      <GoalsPanel
        goals={[followers, tips]}
        modules={modules}
        disabled={false}
        actions={actions()}
      />,
    );
    const f = within(screen.getByTestId('goal-followers'));
    expect(f.getByText('~4,200 / 5,000')).toBeTruthy();
    expect(f.getByText('http://127.0.0.1:4747/m/alerts/goal.html?goal=followers')).toBeTruthy();
    expect(f.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(within(screen.getByTestId('goal-tips')).getByText('$45.50 / $200')).toBeTruthy();
  });

  it('adds a tips goal with a currency and a unique id', () => {
    const a = actions();
    render(<GoalsPanel goals={[tips]} modules={modules} disabled={false} actions={a} />);
    const form = within(screen.getByRole('form', { name: 'New goal' }));
    const add = form.getByRole('button', { name: 'Add goal' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Tips' } });
    fireEvent.change(form.getByLabelText('Counts'), { target: { value: 'tips' } });
    fireEvent.change(form.getByLabelText('Target'), { target: { value: '100' } });
    fireEvent.change(form.getByLabelText('Currency'), { target: { value: 'eur' } });
    const twitch = form.getByRole('checkbox', { name: 'Twitch' }) as HTMLInputElement;
    expect(twitch.disabled).toBe(true);
    expect(twitch.checked).toBe(false);
    fireEvent.click(add);
    expect(a.onSave).toHaveBeenCalledWith({
      id: 'tips-2',
      label: 'Tips',
      metric: 'tips',
      scope: 'stream',
      target: 100,
      currency: 'EUR',
      platforms: ['youtube'],
    });
  });

  it('needs a platform and a valid currency', () => {
    render(<GoalsPanel goals={[]} modules={modules} disabled={false} actions={actions()} />);
    const form = within(screen.getByRole('form', { name: 'New goal' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Fund' } });
    fireEvent.change(form.getByLabelText('Counts'), { target: { value: 'tips' } });
    fireEvent.change(form.getByLabelText('Target'), { target: { value: '50' } });
    fireEvent.change(form.getByLabelText('Currency'), { target: { value: 'US' } });
    expect(form.getByText('Use a 3-letter currency code like USD.')).toBeTruthy();
    fireEvent.change(form.getByLabelText('Currency'), { target: { value: 'USD' } });
    fireEvent.click(form.getByRole('checkbox', { name: 'YouTube' }));
    expect(form.getByText('Pick at least one platform.')).toBeTruthy();
    expect((form.getByRole('button', { name: 'Add goal' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('edits, resets and removes a goal, and warns when an edit restarts the count', () => {
    const a = actions();
    render(<GoalsPanel goals={[followers, tips]} modules={modules} disabled={false} actions={a} />);
    const t = within(screen.getByTestId('goal-tips'));
    fireEvent.click(t.getByRole('button', { name: 'Reset' }));
    expect(a.onReset).toHaveBeenCalledWith('tips');
    fireEvent.click(
      within(screen.getByTestId('goal-followers')).getByRole('button', { name: 'Remove' }),
    );
    expect(a.onRemove).toHaveBeenCalledWith('followers');

    fireEvent.click(
      within(screen.getByTestId('goal-followers')).getByRole('button', { name: 'Edit' }),
    );
    const form = within(screen.getByRole('form', { name: 'Edit Follower goal' }));
    fireEvent.change(form.getByLabelText('Target'), { target: { value: '6000' } });
    expect(form.queryByText(/starts it again/)).toBeNull();
    fireEvent.change(form.getByLabelText('Counted from'), { target: { value: 'stream' } });
    expect(form.getByText(/starts it again from 0/)).toBeTruthy();
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect(a.onSave).toHaveBeenCalledWith({
      id: 'followers',
      label: 'Follower goal',
      metric: 'followers',
      scope: 'stream',
      target: 6000,
      platforms: ['twitch', 'youtube'],
    });
    expect(screen.getByRole('form', { name: 'New goal' })).toBeTruthy();
  });
});
