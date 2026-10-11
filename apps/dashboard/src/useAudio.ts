import { useEffect, useReducer, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { AudioLevels } from '@streamhub/shared';
import { reduceAudio, type Levels } from './audio';

export function useAudio(client: HubClient) {
  const [view, dispatch] = useReducer(reduceAudio, { state: null, devices: null });
  useEffect(() => {
    const offState = client.on('audio.state', dispatch);
    const offDevices = client.on('audio.devices', dispatch);
    return () => {
      offState();
      offDevices();
    };
  }, [client]);
  return view;
}

/** Meter levels change up to 15 times per second; keep them out of App state so only meters re-render. */
export function useAudioLevels(client: HubClient): Levels {
  const [levels, setLevels] = useState<Levels>({});
  useEffect(() => client.on('audio.levels', (e) => setLevels((e.payload as AudioLevels).levels)), [client]);
  return levels;
}
