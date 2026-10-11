import { useEffect, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { HeadsetsState } from '@streamhub/shared';

export function useHeadsets(client: HubClient): HeadsetsState | null {
  const [state, setState] = useState<HeadsetsState | null>(null);
  useEffect(() => {
    const offs = [
      // The hub resends the retained state on reconnect; until then, claim nothing.
      client.onStatus((s) => s !== 'open' && setState(null)),
      client.on('headsets.state', (e) => setState(e.payload as HeadsetsState)),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return state;
}
