import { useEffect, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import { PlatformLiveBadge } from './components/PlatformLive';
import { Preflight } from './components/Preflight';
import { RecordControls } from './components/RecordControls';
import { SoundTab } from './components/SoundTab';
import { StreamControls } from './components/StreamControls';
import { panelId, tabId, TabBar, useTabs } from './components/Tabs';
import { useChatShortcut } from './chatWindow';
import { summarize, type Fix } from './preflight';
import { usePrefs } from './prefs';
import { useAppearance } from './theme';
import { diskWarning } from './recording';
import { LiveTab } from './tabs/Live';
import { OnScreenTab } from './tabs/OnScreen';
import { SettingsArea } from './tabs/Settings';
import { useStudio, type Studio } from './useStudio';

/** Says plainly what is offline, right under the toolbar, with the way to fix it. */
function ConnectionBanner({ studio, onObsSettings }: { studio: Studio; onObsSettings: () => void }) {
  const { state, client } = studio;
  if (!state.hubConnected)
    return (
      <div className="banner bad" role="status">
        <span className="dot" aria-hidden />
        <span className="banner-text">Lost the connection to the streamhub hub. Reconnecting…</span>
      </div>
    );
  if (state.obs.connected) return null;
  return (
    <div className="banner warn" role="status">
      <span className="dot" aria-hidden />
      <span className="banner-text">
        <strong>OBS is not connected.</strong> Scenes, mics and Go live come back when it is.
        {state.obs.detail && <span className="banner-detail"> ({state.obs.detail})</span>}
      </span>
      <button className="sm" onClick={() => client.publish('obs.cmd.reconnect')}>
        Reconnect
      </button>
      <button className="sm ghost" onClick={onObsSettings}>
        OBS settings
      </button>
    </div>
  );
}

export function App({ client }: { client: HubClient }) {
  const [prefs, setPrefs] = usePrefs();
  const [tab, setTab] = useTabs(prefs);
  const studio = useStudio(client);
  const { state, recording, checks, obsReady } = studio;
  useChatShortcut();
  useAppearance(prefs.appearance);
  const platformsNeedAttention = Object.values(state.connections).some((c) => c?.state === 'error');
  const platformLive = Object.values(state.live).filter((l) => l && state.connections[l.platform]?.state === 'connected');
  const disk = state.obs.connected ? diskWarning(recording) : null;

  // A pre-flight Fix can open a given page; any other way into a tab starts on its default page.
  const [target, setTarget] = useState<Pick<Fix, 'tab' | 'section'>>();
  useEffect(() => {
    if (target && target.tab !== tab) setTarget(undefined);
  }, [tab, target]);
  const pageAt = target?.tab === tab ? target.section : undefined;
  const go = (fix: Pick<Fix, 'tab' | 'section'>) => {
    setTarget(fix);
    setTab(fix.tab);
  };

  const panel = () => {
    switch (tab) {
      case 'live':
        return <LiveTab studio={studio} prefs={prefs} />;
      case 'sound':
        return (
          <SoundTab
            state={studio.audio.state}
            devices={studio.audio.devices}
            levels={studio.levels}
            headsets={studio.headsets}
            disabled={!obsReady}
            hubConnected={state.hubConnected}
            actions={studio.audioActions}
            headsetActions={studio.headsetActions}
          />
        );
      case 'onscreen':
        return <OnScreenTab key={pageAt} studio={studio} initial={pageAt} />;
      case 'settings':
        return <SettingsArea key={pageAt} studio={studio} initial={pageAt} prefs={prefs} onPrefs={setPrefs} />;
    }
  };

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region="deep">
        <h1 className="brand">streamhub</h1>
        <TabBar tab={tab} onSelect={setTab} attention={platformsNeedAttention ? ['settings'] : []} />
        <span className="spacer" />
        {platformLive.map((l) => l && <PlatformLiveBadge key={l.platform} live={l} />)}
        {disk && (
          <span className={`disk-chip ${recording?.disk?.level ?? ''}`} role="alert">
            {disk}
          </span>
        )}
        <Preflight checks={checks} onFix={go} />
        <RecordControls
          recording={recording}
          disabled={!obsReady}
          onStart={() => client.publish('recording.cmd.start')}
          onStop={() => client.publish('recording.cmd.stop')}
        />
        <StreamControls
          stream={state.stream}
          disabled={!obsReady}
          problems={summarize(checks).fails}
          onStart={() => client.publish('obs.cmd.startStream')}
          onStop={() => client.publish('obs.cmd.stopStream')}
        />
      </header>
      <ConnectionBanner studio={studio} onObsSettings={() => go({ tab: 'settings', section: 'obs' })} />
      <main className={`workspace tab-${tab}`} role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {panel()}
      </main>
    </div>
  );
}
