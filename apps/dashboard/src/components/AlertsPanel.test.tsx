// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAlertsConfig, type AlertRecent, type ModulesList } from '@streamhub/shared';
import { AlertsPanel, previewText, type AlertActions } from './AlertsPanel';
import { RANGE_SEND_MS } from './ThrottledRange';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const modules = (built = true): ModulesList => ({
  modules: [
    {
      id: 'alerts',
      name: 'Alerts and goals',
      version: '0.1.0',
      built,
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
});

const recent: AlertRecent = {
  queued: 2,
  alerts: [
    {
      id: 'youtube:sc1',
      kind: 'tip',
      platform: 'youtube',
      user: { id: 'u', name: 'ada' },
      amount: 5,
      currency: 'USD',
      amountText: '$5.00',
      at: 0,
    },
    {
      id: 'test:1',
      kind: 'follow',
      platform: 'twitch',
      user: { id: 'test', name: 'Test Viewer' },
      at: 0,
      test: true,
    },
  ],
};

function actions(): AlertActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onTest: vi.fn(),
    onReplay: vi.fn(),
    onSkip: vi.fn(),
    onPause: vi.fn(),
    onSetKind: vi.fn(),
  };
}

describe('previewText', () => {
  it('fills a template with sample values', () => {
    expect(previewText('{user} gifted {count} subs!', 'giftsub')).toBe(
      'Test Viewer gifted 5 subs!',
    );
    expect(previewText('{user} tipped {amount}', 'tip')).toBe('Test Viewer tipped $5.00');
  });
});

describe('AlertsPanel', () => {
  it('lists the pop-up URL, recent alerts and sends test, replay, pause and skip', () => {
    const a = actions();
    render(
      <AlertsPanel
        config={defaultAlertsConfig()}
        recent={recent}
        modules={modules()}
        disabled={false}
        actions={a}
      />,
    );
    expect(screen.getByText('http://127.0.0.1:4747/m/alerts/popup.html')).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
    expect(screen.getByText('ada tipped $5.00!')).toBeTruthy();
    expect(screen.getByText('Test', { selector: '.badge' })).toBeTruthy();

    fireEvent.click(
      within(screen.getByTestId('alert-kind-raid')).getByRole('button', { name: 'Test' }),
    );
    expect(a.onTest).toHaveBeenCalledWith('raid');
    fireEvent.click(screen.getAllByRole('button', { name: 'Replay' })[0]!);
    expect(a.onReplay).toHaveBeenCalledWith('youtube:sc1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause alerts' }));
    expect(a.onPause).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Skip current' }));
    expect(a.onSkip).toHaveBeenCalled();
  });

  it('edits one kind: on/off, text, sound, volume and minimum', () => {
    vi.useFakeTimers();
    const a = actions();
    render(
      <AlertsPanel
        config={defaultAlertsConfig()}
        recent={null}
        modules={modules()}
        disabled={false}
        actions={a}
      />,
    );
    const tip = within(screen.getByTestId('alert-kind-tip'));

    fireEvent.click(tip.getByRole('checkbox'));
    expect(a.onSetKind).toHaveBeenLastCalledWith({ kind: 'tip', enabled: false });

    const text = tip.getByLabelText('Text');
    fireEvent.change(text, { target: { value: '{user} sent {amount}' } });
    expect(tip.getByText(/Preview: Test Viewer sent \$5\.00/)).toBeTruthy();
    fireEvent.click(tip.getByRole('button', { name: 'Save' }));
    expect(a.onSetKind).toHaveBeenLastCalledWith({ kind: 'tip', template: '{user} sent {amount}' });

    fireEvent.change(tip.getByLabelText('Sound'), { target: { value: 'fanfare' } });
    expect(a.onSetKind).toHaveBeenLastCalledWith({ kind: 'tip', sound: 'fanfare' });

    fireEvent.change(tip.getByLabelText('Volume'), { target: { value: '80' } });
    act(() => vi.advanceTimersByTime(RANGE_SEND_MS));
    expect(a.onSetKind).toHaveBeenLastCalledWith({ kind: 'tip', volume: 0.8 });

    const min = tip.getByLabelText('Smallest tip');
    fireEvent.change(min, { target: { value: '2.5' } });
    fireEvent.blur(min);
    expect(a.onSetKind).toHaveBeenLastCalledWith({ kind: 'tip', minAmount: 2.5 });
    fireEvent.change(min, { target: { value: '-1' } });
    fireEvent.blur(min);
    expect(a.onSetKind).toHaveBeenCalledTimes(5);
  });

  it('has no minimum for follows', () => {
    render(
      <AlertsPanel
        config={defaultAlertsConfig()}
        recent={null}
        modules={modules()}
        disabled={false}
        actions={actions()}
      />,
    );
    expect(within(screen.getByTestId('alert-kind-follow')).queryByLabelText(/Smallest/)).toBeNull();
  });

  it('says when the overlays are not built and when Twitch needs a reconnect', () => {
    render(
      <AlertsPanel
        config={defaultAlertsConfig()}
        recent={null}
        modules={modules(false)}
        twitchDetail="Reconnect Twitch to turn on follower alerts."
        disabled={false}
        actions={actions()}
      />,
    );
    expect(screen.getByText(/not built yet/)).toBeTruthy();
    expect(screen.getByText('Reconnect Twitch to turn on follower alerts.')).toBeTruthy();
  });

  it('waits for the hub and disables controls', () => {
    render(<AlertsPanel config={null} recent={null} modules={null} disabled actions={actions()} />);
    expect(screen.getAllByText('Waiting for the hub.').length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('button', { name: 'Skip current' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
