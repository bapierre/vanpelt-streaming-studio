import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { CHAT_LIMIT, initialState, reduce, type DashboardState } from './state';

export function useDashboardState(client: HubClient): DashboardState {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    const onEvent = (event: Envelope) => dispatch({ kind: 'event', event });
    const offs = [
      client.onStatus((s) => {
        dispatch({ kind: 'hub', connected: s === 'open' });
        if (s === 'open') {
          client
            .history('chat.message', Math.min(200, CHAT_LIMIT))
            .then((events) => dispatch({ kind: 'backfill', events }))
            .catch(() => {});
        }
      }),
      client.on('obs.', onEvent),
      client.on('platform.', onEvent),
      client.on('chat.', onEvent),
      client.on('show.feature.', onEvent),
      client.on('connections.', onEvent),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return state;
}
