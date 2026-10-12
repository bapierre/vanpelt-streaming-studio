// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAlertsConfig, type GoalState, type ModulesList } from '@streamhub/shared';
import { OnScreenTab } from './OnScreen';
import type { Studio } from '../useStudio';
import { MAX_GOALS } from '../components/GoalsPanel';

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
          id: 'popup',
          name: 'Alert pop-up',
          url: 'http://127.0.0.1:4747/m/alerts/popup.html',
          width: 1920,
          height: 1080,
        },
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

const goal: GoalState = {
  id: 'followers',
  label: 'Road to 100',
  metric: 'followers',
  scope: 'stream',
  target: 100,
  platforms: ['twitch'],
  current: 64,
};

/** Only the parts of the studio the tab reads. */
function studio(over: { paused?: boolean; connected?: boolean; goals?: GoalState[] | null } = {}) {
  const goals = over.goals === undefined ? [goal] : over.goals;
  return {
    state: { hubConnected: over.connected ?? true, platforms: {} },
    alerts: {
      config: { ...defaultAlertsConfig(), paused: over.paused ?? false },
      recent: null,
      goals: goals === null ? null : { goals },
      modules,
    },
    alertActions: {
      onTest: vi.fn(),
      onReplay: vi.fn(),
      onSkip: vi.fn(),
      onPause: vi.fn(),
      onSetKind: vi.fn(),
    },
    goalActions: { onSave: vi.fn(), onRemove: vi.fn(), onReset: vi.fn() },
  } as unknown as Studio;
}

describe('OnScreenTab', () => {
  it('opens on Alerts, with pause in the head and the kind rows below', () => {
    render(<OnScreenTab studio={studio()} />);
    expect(screen.getByRole('region', { name: 'Alerts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Alerts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause alerts' })).toBeTruthy();
    expect(screen.getByTestId('alert-kind-follow')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip current' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Goals' })).toBeNull();
  });

  it('opens on Goals when asked, and switches pages from the sidebar', () => {
    render(<OnScreenTab studio={studio()} initial="goals" />);
    expect(screen.getByRole('region', { name: 'Goals' })).toBeTruthy();
    expect(screen.queryByTestId('alert-kind-follow')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Alerts/ }));
    expect(screen.getByRole('region', { name: 'Alerts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Goals/ }));
    expect(screen.getByRole('region', { name: 'Goals' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ New goal' })).toBeTruthy();
  });

  it('pauses and resumes alerts from the head', () => {
    const s = studio();
    render(<OnScreenTab studio={s} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause alerts' }));
    expect(s.alertActions.onPause).toHaveBeenCalledWith(true);
  });

  it('says Resume when alerts are already paused', () => {
    render(<OnScreenTab studio={studio({ paused: true })} />);
    const button = screen.getByRole('button', { name: 'Resume alerts' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('adds a goal from the + New goal button in the head', () => {
    const s = studio();
    render(<OnScreenTab studio={s} initial="goals" />);
    fireEvent.click(screen.getByRole('button', { name: '+ New goal' }));
    const form = within(screen.getByRole('form', { name: 'New goal' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Sub goal' } });
    fireEvent.change(form.getByLabelText('Target'), { target: { value: '25' } });
    fireEvent.click(form.getByRole('button', { name: 'Add goal' }));
    expect(s.goalActions.onSave).toHaveBeenCalledWith({
      id: 'sub-goal',
      label: 'Sub goal',
      metric: 'followers',
      scope: 'stream',
      target: 25,
      platforms: ['twitch', 'youtube'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('edits a goal inline and closes the form on save', () => {
    const s = studio();
    render(<OnScreenTab studio={s} initial="goals" />);
    fireEvent.click(
      within(screen.getByTestId('goal-followers')).getByRole('button', { name: 'Edit' }),
    );
    const form = within(screen.getByRole('form', { name: 'Edit Road to 100' }));
    fireEvent.change(form.getByLabelText('Target'), { target: { value: '200' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect(s.goalActions.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'followers', target: 200 }),
    );
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('disables the head buttons while the hub is away', () => {
    render(<OnScreenTab studio={studio({ connected: false, goals: null })} />);
    expect(
      (screen.getByRole('button', { name: 'Pause alerts' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    render(<OnScreenTab studio={studio({ connected: false, goals: null })} initial="goals" />);
    expect((screen.getByRole('button', { name: '+ New goal' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Waiting for the hub.')).toBeTruthy();
  });

  it('refuses a new goal at the limit, in plain words', () => {
    const twenty = Array.from({ length: MAX_GOALS }, (_, i): GoalState => ({
      ...goal,
      id: `g${i}`,
      label: `G${i}`,
    }));
    render(<OnScreenTab studio={studio({ goals: twenty })} initial="goals" />);
    const button = screen.getByRole('button', { name: '+ New goal' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(`You have the most goals allowed (${MAX_GOALS}).`);
    expect(screen.getByText(new RegExp(`most goals allowed \\(${MAX_GOALS}\\)`))).toBeTruthy();
  });
});
