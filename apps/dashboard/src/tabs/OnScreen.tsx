import { useState } from 'react';
import { AlertsPanel } from '../components/AlertsPanel';
import { GoalsPanel } from '../components/GoalsPanel';
import { PageHead, SideNav, type NavPage } from '../components/ui';
import type { Studio } from '../useStudio';

/** What viewers see on top of the video: alerts and goal bars. Changed per show, not once. */
export function OnScreenTab({ studio, initial }: { studio: Studio; initial?: string }) {
  const { state, alerts } = studio;
  const [page, setPage] = useState(initial === 'goals' ? 'goals' : 'alerts');
  const kinds = alerts.config ? Object.values(alerts.config.kinds ?? {}).filter((k) => k?.enabled).length : undefined;
  const goals = alerts.goals?.goals.length;
  const pages: NavPage[] = [
    { id: 'alerts', label: 'Alerts', group: 'On screen', note: kinds !== undefined ? `${kinds} on` : undefined },
    { id: 'goals', label: 'Goals', group: 'On screen', note: goals || undefined },
  ];
  return (
    <div className="split">
      <SideNav pages={pages} current={page} label="On screen pages" onSelect={setPage} />
      <section className="split-body" aria-label={page === 'alerts' ? 'Alerts' : 'Goals'}>
        <div className="split-inner">
          {page === 'alerts' ? (
            <>
              <PageHead title="Alerts">
                Follows, subs, cheers, Super Chats and raids pop up one at a time with a sound. Test alerts never count toward a goal.
              </PageHead>
              <AlertsPanel
                config={alerts.config}
                recent={alerts.recent}
                modules={alerts.modules}
                twitchDetail={state.platforms.twitch?.detail}
                disabled={!state.hubConnected}
                actions={studio.alertActions}
              />
            </>
          ) : (
            <>
              <PageHead title="Goals">Each goal is a bar you can put on screen. Add it to OBS with its link.</PageHead>
              <GoalsPanel
                goals={alerts.goals?.goals ?? null}
                modules={alerts.modules}
                disabled={!state.hubConnected}
                actions={studio.goalActions}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
