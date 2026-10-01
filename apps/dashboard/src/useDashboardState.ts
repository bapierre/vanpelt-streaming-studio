import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { initialState, reduce, type DashboardState } from './state';

export function useDashboardState(client: HubClient): DashboardState {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    const onEvent = (event: Envelope) => dispatch({ kind: 'event', event });
    const offs = [
      client.onStatus((s) => dispatch({ kind: 'hub', connected: s === 'open' })),
      client.on('obs.', onEvent),
      client.on('platform.', onEvent),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return state;
}
