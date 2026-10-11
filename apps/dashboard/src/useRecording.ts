import { useEffect, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { RecordingSession } from '@streamhub/shared';

export function useRecording(client: HubClient): RecordingSession | null {
  const [state, setState] = useState<RecordingSession | null>(null);
  useEffect(() => {
    const offs = [
      // The hub resends the retained state on reconnect; until then, claim nothing.
      client.onStatus((s) => s !== 'open' && setState(null)),
      client.on('recording.state', (e) => setState(e.payload as RecordingSession)),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);
  return state;
}
