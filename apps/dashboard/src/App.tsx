import type { HubClient } from '@streamhub/overlay-sdk';
import type { ChatMessage } from '@streamhub/shared';
import { AlertsPanel, type AlertActions } from './components/AlertsPanel';
import { Mixer, WithLevels, type AudioActions } from './components/AudioPanel';
import { CamerasPanel, CameraSwitcher } from './components/CamerasPanel';
import { ChatPanel } from './components/ChatPanel';
import { ChatTab } from './components/ChatTab';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { DestinationsPanel } from './components/DestinationsPanel';
import { GoalsPanel, type GoalActions } from './components/GoalsPanel';
import type { HeadsetActions } from './components/HeadsetMatrix';
import { ObsSettings, ObsTools } from './components/Obs';
import { PlatformLiveBadge } from './components/PlatformLive';
import { RecordControls } from './components/RecordControls';
import { RecordingPanel } from './components/RecordingPanel';
import { ScenePanel } from './components/ScenePanel';
import { GeneralSettings, SettingsTab } from './components/SettingsTab';
import { SoundTab } from './components/SoundTab';
import { SourcesPanel } from './components/SourcesPanel';
import { StatusBar } from './components/StatusBar';
import { StreamControls } from './components/StreamControls';
import { panelId, tabId, TabBar, useTabs } from './components/Tabs';
import { usePrefs } from './prefs';
import { useAlerts } from './useAlerts';
import { useAudio } from './useAudio';
import { useCameras } from './useCameras';
import { useDashboardState } from './useDashboardState';
import { useHeadsets } from './useHeadsets';
import { useRecording } from './useRecording';

export function App({ client }: { client: HubClient }) {
  const [prefs, setPrefs] = usePrefs();
  const [tab, setTab] = useTabs(prefs);
  const state = useDashboardState(client);
  const cameras = useCameras(client);
  const recording = useRecording(client);
  const headsets = useHeadsets(client);
  const alerts = useAlerts(client);
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
  const headsetActions: HeadsetActions = {
    onAdd: (add) => client.publish('headsets.cmd.add', add),
    onUpdate: (patch) => client.publish('headsets.cmd.update', patch),
    onRemove: (id) => client.publish('headsets.cmd.remove', { id }),
    onSetSend: (patch) => client.publish('headsets.cmd.setSend', patch),
    onListOutputs: () => client.publish('headsets.cmd.listOutputs'),
  };
  const alertActions: AlertActions = {
    onTest: (kind) => client.publish('alert.cmd.test', { kind }),
    onReplay: (id) => client.publish('alert.cmd.replay', { id }),
    onSkip: () => client.publish('alert.cmd.skip', {}),
    onPause: (paused) => client.publish('alert.cmd.pause', { paused }),
    onSetKind: (patch) => client.publish('alert.cmd.setKind', patch),
  };
  const goalActions: GoalActions = {
    onSave: (goal) => client.publish('goal.cmd.save', goal),
    onRemove: (id) => client.publish('goal.cmd.remove', { id }),
    onReset: (id) => client.publish('goal.cmd.reset', { id }),
  };
  const obsReady = state.hubConnected && state.obs.connected;
  const live = state.stream.state !== 'stopped';
  const platformsNeedAttention = Object.values(state.connections).some((c) => c?.state === 'error');
  const platformLive = Object.values(state.live).filter((l) => l && state.connections[l.platform]?.state === 'connected');
  const onFeature = (message: ChatMessage) => client.publish('show.feature.set', { message });
  const onClearFeature = () => client.publish('show.feature.clear');

  const panel = () => {
    switch (tab) {
      case 'live':
        return (
          <div className="live">
            <aside className="sidebar">
              <CameraSwitcher cameras={cameras} disabled={!obsReady} onTake={takeCamera} />
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
            <section className="live-mixer" aria-label="Mixer">
              {audio.state && audio.state.mics.length > 0 ? (
                <WithLevels client={client}>
                  {(levels) => <Mixer mics={audio.state?.mics ?? []} levels={levels} disabled={!obsReady} onSet={audioActions.onSet} />}
                </WithLevels>
              ) : (
                <p className="side-empty small">No mics yet. Add them in the Sound tab.</p>
              )}
            </section>
            <div className="live-chat">
              <ChatPanel
                compact
                size={prefs.chatSize}
                messages={state.chat}
                featuredId={state.featuredId}
                onFeature={onFeature}
                onClearFeature={onClearFeature}
              />
            </div>
          </div>
        );
      case 'sound':
        return (
          <WithLevels client={client}>
            {(levels) => (
              <SoundTab
                state={audio.state}
                devices={audio.devices}
                levels={levels}
                headsets={headsets}
                disabled={!obsReady}
                hubConnected={state.hubConnected}
                actions={audioActions}
                headsetActions={headsetActions}
              />
            )}
          </WithLevels>
        );
      case 'chat':
        return (
          <ChatTab
            messages={state.chat}
            featuredId={state.featuredId}
            size={prefs.chatSize}
            onFeature={onFeature}
            onClearFeature={onClearFeature}
          />
        );
      case 'settings':
        return (
          <SettingsTab
            initial={platformsNeedAttention ? 'platforms' : 'general'}
            sections={[
              {
                id: 'general',
                label: 'General',
                content: (
                  <GeneralSettings
                    targetDb={audio.state?.targetDb ?? null}
                    disabled={!state.hubConnected}
                    prefs={prefs}
                    onTarget={audioActions.onTarget}
                    onPrefs={setPrefs}
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
                id: 'alerts',
                label: 'Alerts',
                content: (
                  <AlertsPanel
                    config={alerts.config}
                    recent={alerts.recent}
                    modules={alerts.modules}
                    twitchDetail={state.platforms.twitch?.detail}
                    disabled={!state.hubConnected}
                    actions={alertActions}
                  />
                ),
              },
              {
                id: 'goals',
                label: 'Goals',
                content: (
                  <GoalsPanel goals={alerts.goals?.goals ?? null} modules={alerts.modules} disabled={!state.hubConnected} actions={goalActions} />
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
  };

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
        <TabBar tab={tab} onSelect={setTab} attention={platformsNeedAttention ? ['settings'] : []} />
        <span className="spacer" />
        {platformLive.map((l) => l && <PlatformLiveBadge key={l.platform} live={l} />)}
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
      <main className={`workspace tab-${tab}`} role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {panel()}
      </main>
      <StatusBar state={state} recording={recording} />
    </div>
  );
}
