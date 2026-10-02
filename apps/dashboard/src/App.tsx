import { useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import { ChatPanel } from './components/ChatPanel';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { ScenePanel } from './components/ScenePanel';
import { StatusBar } from './components/StatusBar';
import { StreamControls } from './components/StreamControls';
import { useDashboardState } from './useDashboardState';

export function App({ client }: { client: HubClient }) {
  const [view, setView] = useState<'show' | 'connections'>('show');
  const state = useDashboardState(client);
  const obsReady = state.hubConnected && state.obs.connected;
  return (
    <div className="app">
      <header>
        <h1>streamhub</h1>
        <nav className="tabs">
          <button aria-pressed={view === 'show'} onClick={() => setView('show')}>Show</button>
          <button aria-pressed={view === 'connections'} onClick={() => setView('connections')}>Connections</button>
        </nav>
        <StreamControls
          stream={state.stream}
          disabled={!obsReady}
          onStart={() => client.publish('obs.cmd.startStream')}
          onStop={() => client.publish('obs.cmd.stopStream')}
        />
      </header>
      {view === 'show' ? (
        <main>
          <ScenePanel
            scenes={state.scenes}
            current={state.currentScene}
            disabled={!obsReady}
            onSelect={(scene) => client.publish('obs.cmd.setScene', { scene })}
          />
          <ChatPanel
            messages={state.chat}
            featuredId={state.featuredId}
            onFeature={(message) => client.publish('show.feature.set', { message })}
            onClearFeature={() => client.publish('show.feature.clear')}
          />
        </main>
      ) : (
        <main className="single">
          <ConnectionsPanel
            connections={state.connections}
            onConnect={(platform) => client.publish('connections.cmd.connect', { platform })}
            onDisconnect={(platform) => client.publish('connections.cmd.disconnect', { platform })}
            onSetYoutubeClient={(clientId, clientSecret) => client.publish('connections.cmd.setYoutubeClient', { clientId, clientSecret })}
          />
        </main>
      )}
      <StatusBar state={state} />
    </div>
  );
}
