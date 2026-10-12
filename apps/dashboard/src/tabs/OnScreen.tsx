import { useState } from 'react';
import { AlertsPanel, PauseAlerts } from '../components/AlertsPanel';
import { GoalsPanel, MAX_GOALS, type GoalFormSel } from '../components/GoalsPanel';
import { PageHead, SideNav, type NavPage } from '../components/ui';
import type { Studio } from '../useStudio';

/** What viewers see on top of the video: alerts and goal bars. Changed per show, not once. */
export function OnScreenTab({ studio, initial }: { studio: Studio; initial?: string }) {
  const { state, alerts } = studio;
  const [page, setPage] = useState(initial === 'goals' ? 'goals' : 'alerts');
  const [goalForm, setGoalForm] = useState<GoalFormSel | null>(null);
  const off = !state.hubConnected;
  const kinds = alerts.config
    ? Object.values(alerts.config.kinds ?? {}).filter((k) => k?.enabled).length
    : undefined;
  const goalCount = alerts.goals?.goals.length;
  const maxed = (goalCount ?? 0) >= MAX_GOALS;
  const pages: NavPage[] = [
    {
      id: 'alerts',
      label: 'Alerts',
      group: 'On screen',
      note: kinds !== undefined ? `${kinds} on` : undefined,
    },
    { id: 'goals', label: 'Goals', group: 'On screen', note: goalCount || undefined },
  ];
  return (
    <div className="split">
      <SideNav pages={pages} current={page} label="On screen pages" onSelect={setPage} />
      <section className="split-body" aria-label={page === 'alerts' ? 'Alerts' : 'Goals'}>
        <div className="split-inner">
          {page === 'alerts' ? (
            <>
              <PageHead
                title="Alerts"
                actions={
                  <PauseAlerts
                    paused={alerts.config?.paused ?? false}
                    disabled={off || !alerts.config}
                    onPause={studio.alertActions.onPause}
                  />
                }
              >
                Follows, subs, cheers, Super Chats and raids pop up one at a time with a sound. Test
                alerts never count toward a goal.
              </PageHead>
              <AlertsPanel
                config={alerts.config}
                recent={alerts.recent}
                modules={alerts.modules}
                twitchDetail={state.platforms.twitch?.detail}
                disabled={off}
                actions={studio.alertActions}
              />
            </>
          ) : (
            <>
              <PageHead
                title="Goals"
                actions={
                  <button
                    type="button"
                    className="primary big"
                    disabled={off || !alerts.goals || maxed}
                    title={maxed ? `You have the most goals allowed (${MAX_GOALS}).` : undefined}
                    onClick={() => setGoalForm({ mode: 'new' })}
                  >
                    + New goal
                  </button>
                }
              >
                Each goal is a bar you can put on screen. Add it to OBS with its link.
              </PageHead>
              <GoalsPanel
                goals={alerts.goals?.goals ?? null}
                modules={alerts.modules}
                disabled={off}
                actions={studio.goalActions}
                form={goalForm}
                onForm={setGoalForm}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
