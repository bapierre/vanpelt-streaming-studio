import { useEffect, useReducer } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import { cameraList, reduceCameras } from './cameras';

export function useCameras(client: HubClient) {
  const [state, dispatch] = useReducer(reduceCameras, {});
  useEffect(() => client.on('camera.state', dispatch), [client]);
  return cameraList(state);
}
