import { useEffect, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { AlertRecent, AlertsConfig, GoalsState, ModulesList } from '@streamhub/shared';

export type AlertsView = {
  config: AlertsConfig | null;
  recent: AlertRecent | null;
  goals: GoalsState | null;
  modules: ModulesList | null;
};

const EMPTY: AlertsView = { config: null, recent: null, goals: null, modules: null };

export function useAlerts(client: HubClient): AlertsView {
  const [view, setView] = useState<AlertsView>(EMPTY);
  useEffect(() => {
    const offs = [
      // The hub resends all four retained states on reconnect; until then, claim nothing.
      client.onStatus((s) => s !== 'open' && setView(EMPTY)),
      client.on('alert.config', (e) =>
        setView((v) => ({ ...v, config: e.payload as AlertsConfig })),
      ),
      client.on('alert.recent', (e) =>
        setView((v) => ({ ...v, recent: e.payload as AlertRecent })),
      ),
      client.on('goal.state', (e) => setView((v) => ({ ...v, goals: e.payload as GoalsState }))),
      client.on('modules.list', (e) =>
        setView((v) => ({ ...v, modules: e.payload as ModulesList })),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return view;
}
