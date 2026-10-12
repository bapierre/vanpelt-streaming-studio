import { CamerasPanel } from '../components/CamerasPanel';
import { ConnectionsPanel } from '../components/ConnectionsPanel';
import { DestinationsPanel } from '../components/DestinationsPanel';
import { ObsSettings } from '../components/Obs';
import { GeneralSettings, SettingsTab } from '../components/SettingsTab';
import type { Prefs } from '../prefs';
import type { Studio } from '../useStudio';

/** One-time setup: connections, gear and app preferences. */
export function SettingsArea({
  studio,
  initial,
  prefs,
  onPrefs,
}: {
  studio: Studio;
  initial?: string;
  prefs: Prefs;
  onPrefs: (change: Partial<Prefs>) => void;
}) {
  const { client, state, audio, cameras, obsReady } = studio;
  const platformsNeedAttention = Object.values(state.connections).some((c) => c?.state === 'error');
  const live = state.stream.state !== 'stopped';
  return (
    <SettingsTab
      initial={initial ?? (platformsNeedAttention ? 'platforms' : 'general')}
      sections={[
        {
          id: 'general',
          label: 'General',
          content: (
            <GeneralSettings
              targetDb={audio.state?.targetDb ?? null}
              disabled={!state.hubConnected}
              prefs={prefs}
              onTarget={studio.audioActions.onTarget}
              onPrefs={onPrefs}
            />
          ),
        },
        {
          id: 'obs',
          label: 'OBS',
          content: (
            <ObsSettings
              obs={state.obs}
              settings={state.obsSettings}
              onSave={(url, password) => client.publish('connections.cmd.setObs', password === undefined ? { url } : { url, password })}
              onReconnect={() => client.publish('obs.cmd.reconnect')}
            />
          ),
        },
        {
          id: 'platforms',
          label: 'Platforms',
          attention: platformsNeedAttention,
          content: (
            <ConnectionsPanel
              connections={state.connections}
              live={state.live}
              onConnect={(platform) => client.publish('connections.cmd.connect', { platform })}
              onDisconnect={(platform) => client.publish('connections.cmd.disconnect', { platform })}
              onSetYoutubeClient={(clientId, clientSecret) => client.publish('connections.cmd.setYoutubeClient', { clientId, clientSecret })}
              onSetXClient={(clientId) => client.publish('connections.cmd.setXClient', { clientId })}
            />
          ),
        },
        {
          id: 'cameras',
          label: 'Cameras',
          content: (
            <CamerasPanel
              cameras={cameras}
              disabled={!state.hubConnected}
              onTake={studio.takeCamera}
              onSet={(id, key, value) => client.publish('camera.cmd.set', { id, key, value })}
            />
          ),
        },
        {
          id: 'destinations',
          label: 'Stream keys',
          content: (
            <DestinationsPanel
              list={state.destinations}
              obsReady={obsReady}
              live={live}
              onSave={(d) => client.publish('destinations.cmd.save', d)}
              onRemove={(id) => client.publish('destinations.cmd.remove', { id })}
              onUseInObs={(id) => client.publish('destinations.cmd.useInObs', { id })}
            />
          ),
        },
      ]}
    />
  );
}
