import { useEffect, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import { AudioPanel, Mixer, WithLevels, type AudioActions } from './components/AudioPanel';
import { CamerasPanel, CameraSwitcher } from './components/CamerasPanel';
import { ChatPanel } from './components/ChatPanel';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { DestinationsPanel } from './components/DestinationsPanel';
import { Icon } from './components/Icon';
import { ObsSettings, ObsTools } from './components/Obs';
import { PlatformLiveBadge } from './components/PlatformLive';
import { RecordControls } from './components/RecordControls';
import { RecordingPanel } from './components/RecordingPanel';
import { ScenePanel } from './components/ScenePanel';
import { SettingsSheet } from './components/SettingsSheet';
import { SourcesPanel } from './components/SourcesPanel';
import { StatusBar } from './components/StatusBar';
import { StreamControls } from './components/StreamControls';
import { useAudio } from './useAudio';
import { useCameras } from './useCameras';
import { useDashboardState } from './useDashboardState';
import { useRecording } from './useRecording';

export function App({ client }: { client: HubClient }) {
  // Setup lives in a sheet that is closed by default, so a shared screen never shows keys or codes.
  const [settings, setSettings] = useState<string | null>(null);
  const state = useDashboardState(client);
  const cameras = useCameras(client);
  const recording = useRecording(client);
  const takeCamera = (id: string) => client.publish('camera.cmd.take', { id });
  const audio = useAudio(client);
  const audioActions: AudioActions = {
    onSet: (patch) => client.publish('audio.cmd.set', patch),
    onSoundcheck: (id, action) => client.publish('audio.cmd.soundcheck', { id, action }),
    onTarget: (targetDb) => client.publish('audio.cmd.setTarget', { targetDb }),
    onAdd: (add) => client.publish('audio.cmd.add', add),
    onRemove: (id) => client.publish('audio.cmd.remove', { id }),
    onNest: () => client.publish('audio.cmd.nest', {}),
    onListDevices: () => client.publish('audio.cmd.listDevices'),
  };
  const obsReady = state.hubConnected && state.obs.connected;
  const live = state.stream.state !== 'stopped';
  const platformsNeedAttention = Object.values(state.connections).some((c) => c?.state === 'error');
  const openSettings = () => setSettings(platformsNeedAttention ? 'platforms' : 'obs');
  const platformLive = Object.values(state.live).filter((l) => l && state.connections[l.platform]?.state === 'connected');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setSettings((s) => s ?? 'obs');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region="deep">
        <h1 className="brand">streamhub</h1>
        <ObsTools
          obs={state.obs}
          hubConnected={state.hubConnected}
          onRefresh={() => client.publish('obs.cmd.refresh')}
          onReconnect={() => client.publish('obs.cmd.reconnect')}
        />
        <span className="spacer" />
        {platformLive.map((l) => l && <PlatformLiveBadge key={l.platform} live={l} />)}
        <button className="icon-button settings-button" aria-label="Settings" title="Settings (⌘,)" onClick={openSettings}>
          <Icon name="settings" />
          {platformsNeedAttention && <span className="attention" />}
        </button>
        <RecordControls
          recording={recording}
          disabled={!obsReady}
          onStart={() => client.publish('recording.cmd.start')}
          onStop={() => client.publish('recording.cmd.stop')}
        />
        <StreamControls
          stream={state.stream}
          disabled={!obsReady}
          onStart={() => client.publish('obs.cmd.startStream')}
          onStop={() => client.publish('obs.cmd.stopStream')}
        />
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <CameraSwitcher cameras={cameras} disabled={!obsReady} onTake={takeCamera} />
          <WithLevels client={client}>
            {(levels) => <Mixer mics={audio.state?.mics ?? []} levels={levels} disabled={!obsReady} onSet={audioActions.onSet} />}
          </WithLevels>
          <ScenePanel
            scenes={state.scenes}
            current={state.currentScene}
            disabled={!obsReady}
            onSelect={(scene) => client.publish('obs.cmd.setScene', { scene })}
          />
          <SourcesPanel
            sources={state.sources}
            disabled={!obsReady}
            onToggle={(scene, source, visible) => client.publish('obs.cmd.setSourceVisible', { scene, source, visible })}
          />
          <RecordingPanel recording={recording} />
        </aside>
        <main className="content">
          <ChatPanel
            messages={state.chat}
            featuredId={state.featuredId}
            onFeature={(message) => client.publish('show.feature.set', { message })}
            onClearFeature={() => client.publish('show.feature.clear')}
          />
        </main>
      </div>
      <StatusBar state={state} recording={recording} />
      {settings && (
        <SettingsSheet
          initial={settings}
          onClose={() => setSettings(null)}
          tabs={[
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
                  onTake={takeCamera}
                  onSet={(id, key, value) => client.publish('camera.cmd.set', { id, key, value })}
                />
              ),
            },
            {
              id: 'audio',
              label: 'Audio',
              content: (
                <WithLevels client={client}>
                  {(levels) => (
                    <AudioPanel
                      state={audio.state}
                      devices={audio.devices}
                      levels={levels}
                      disabled={!obsReady}
                      actions={audioActions}
                    />
                  )}
                </WithLevels>
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
      )}
    </div>
  );
}
