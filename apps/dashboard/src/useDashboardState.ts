import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
import { CHAT_LIMIT, initialState, reduce, type DashboardState } from './state';

export function useDashboardState(client: HubClient): DashboardState {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    // Chat messages arrive one event each; a burst would re-render the panel (and
    // force a scroll layout) per message. Queue them and flush once per frame.
    let batch: Envelope[] = [];
    let scheduled: number | null = null;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const schedule = (fn: () => void): number =>
      hasRaf ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number);
    const cancel = (id: number) => (hasRaf ? cancelAnimationFrame(id) : clearTimeout(id));
    const flush = () => {
      scheduled = null;
      if (batch.length === 0) return;
      dispatch({ kind: 'chatBatch', events: batch });
      batch = [];
    };
    const onEvent = (event: Envelope) => {
      if (event.type === 'chat.message') {
        batch.push(event);
        if (scheduled === null) scheduled = schedule(flush);
        return;
      }
      // Keep the wire order: a delete/clear must not overtake the queued messages.
      if (event.type.startsWith('chat.') && scheduled !== null) {
        cancel(scheduled);
        flush();
      }
      dispatch({ kind: 'event', event });
    };
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
      client.on('destinations.', onEvent),
    ];
    return () => {
      offs.forEach((off) => off());
      if (scheduled !== null) cancel(scheduled);
    };
  }, [client]);
  return state;
}
