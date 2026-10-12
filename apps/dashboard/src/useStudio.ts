import { useCallback, useMemo } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { ChatMessage } from '@streamhub/shared';
import type { AlertActions } from './components/AlertsPanel';
import type { AudioActions } from './components/AudioPanel';
import type { GoalActions } from './components/GoalsPanel';
import type { HeadsetActions } from './components/HeadsetMatrix';
import { createLevelsStore } from './levels';
import { preflightChecks } from './preflight';
import { useAlerts } from './useAlerts';
import { useAudio } from './useAudio';
import { useCameras } from './useCameras';
import { useDashboardState } from './useDashboardState';
import { useHeadsets } from './useHeadsets';
import { createPreviewsStore, type PreviewsStore } from './usePreviews';
import { useRecording } from './useRecording';

/** Everything the hub tells the dashboard, plus the commands back. Each tab takes what it needs. */
export function useStudio(client: HubClient) {
  const state = useDashboardState(client);
  const cameras = useCameras(client);
  const recording = useRecording(client);
  const headsets = useHeadsets(client);
  const alerts = useAlerts(client);
  const audio = useAudio(client);
  // Meter levels live outside React state so their 15 Hz tick only re-renders meters.
  const levels = useMemo(() => createLevelsStore(client), [client]);
  // Scene previews live outside React state for the same reason: the program image changes ~1 Hz.
  const previews = useMemo<PreviewsStore>(() => createPreviewsStore(client), [client]);

  const audioActions = useMemo<AudioActions>(
    () => ({
      onSet: (patch) => client.publish('audio.cmd.set', patch),
      onSoundcheck: (id, action) => client.publish('audio.cmd.soundcheck', { id, action }),
      onTarget: (targetDb) => client.publish('audio.cmd.setTarget', { targetDb }),
      onAdd: (add) => client.publish('audio.cmd.add', add),
      onRemove: (id) => client.publish('audio.cmd.remove', { id }),
      onNest: () => client.publish('audio.cmd.nest', {}),
      onListDevices: () => client.publish('audio.cmd.listDevices'),
    }),
    [client],
  );
  const headsetActions = useMemo<HeadsetActions>(
    () => ({
      onAdd: (add) => client.publish('headsets.cmd.add', add),
      onUpdate: (patch) => client.publish('headsets.cmd.update', patch),
      onRemove: (id) => client.publish('headsets.cmd.remove', { id }),
      onSetSend: (patch) => client.publish('headsets.cmd.setSend', patch),
      onSetStream: (patch) => client.publish('headsets.cmd.setStream', patch),
      onRenameSource: (patch) => client.publish('headsets.cmd.renameSource', patch),
      onListOutputs: () => client.publish('headsets.cmd.listOutputs'),
    }),
    [client],
  );
  const alertActions = useMemo<AlertActions>(
    () => ({
      onTest: (kind) => client.publish('alert.cmd.test', { kind }),
      onReplay: (id) => client.publish('alert.cmd.replay', { id }),
      onSkip: () => client.publish('alert.cmd.skip', {}),
      onPause: (paused) => client.publish('alert.cmd.pause', { paused }),
      onSetKind: (patch) => client.publish('alert.cmd.setKind', patch),
    }),
    [client],
  );
  const goalActions = useMemo<GoalActions>(
    () => ({
      onSave: (goal) => client.publish('goal.cmd.save', goal),
      onRemove: (id) => client.publish('goal.cmd.remove', { id }),
      onReset: (id) => client.publish('goal.cmd.reset', { id }),
    }),
    [client],
  );
  const takeCamera = useCallback((id: string) => client.publish('camera.cmd.take', { id }), [client]);
  const onFeature = useCallback((message: ChatMessage) => client.publish('show.feature.set', { message }), [client]);
  const onClearFeature = useCallback(() => client.publish('show.feature.clear'), [client]);

  const obsReady = state.hubConnected && state.obs.connected;
  const checks = useMemo(
    () => preflightChecks({ state, audio: audio.state, headsets, recording, cameras, alerts: alerts.config }),
    [state, audio.state, headsets, recording, cameras, alerts.config],
  );

  return {
    client,
    state,
    cameras,
    recording,
    headsets,
    alerts,
    audio,
    levels,
    previews,
    audioActions,
    headsetActions,
    alertActions,
    goalActions,
    takeCamera,
    onFeature,
    onClearFeature,
    obsReady,
    checks,
  };
}

export type Studio = ReturnType<typeof useStudio>;
