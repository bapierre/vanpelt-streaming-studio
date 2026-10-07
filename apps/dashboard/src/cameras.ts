import type { CameraControl, CameraState, Envelope } from '@streamhub/shared';

export type CamerasState = Record<string, CameraState>;

export function reduceCameras(state: CamerasState, event: Envelope): CamerasState {
  if (event.type !== 'camera.state') return state;
  const cam = event.payload as CameraState;
  return { ...state, [cam.id]: cam };
}

/** Config order is not on the wire, so sort by name for a stable layout. */
export const cameraList = (state: CamerasState): CameraState[] =>
  Object.values(state).sort((a, b) => a.name.localeCompare(b.name));

export const isObsControl = (c: CameraControl) => c.key.startsWith('obs.');

export function canTake(cam: CameraState): boolean {
  return !cam.obsDetail && !cam.onAir;
}

export const STATUS_LABEL: Record<CameraState['status'], string> = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  ready: 'ready',
  streaming: 'streaming',
  error: 'error',
};
