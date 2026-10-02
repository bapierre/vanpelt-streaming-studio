import type { HubClient } from '@streamhub/overlay-sdk';
import { ChatPanel } from './components/ChatPanel';
import { ScenePanel } from './components/ScenePanel';
import { StatusBar } from './components/StatusBar';
import { StreamControls } from './components/StreamControls';
import { useDashboardState } from './useDashboardState';

export function App({ client }: { client: HubClient }) {
  const state = useDashboardState(client);
  const obsReady = state.hubConnected && state.obs.connected;
  return (
    <div className="app">
      <header>
        <h1>streamhub</h1>
        <StreamControls
          stream={state.stream}
          disabled={!obsReady}
          onStart={() => client.publish('obs.cmd.startStream')}
          onStop={() => client.publish('obs.cmd.stopStream')}
        />
      </header>
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
      <StatusBar state={state} />
    </div>
  );
}
