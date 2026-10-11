import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import { reduceAudio } from './audio';

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
