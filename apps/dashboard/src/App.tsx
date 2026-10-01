import type { HubClient } from '@streamhub/overlay-sdk';
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
        <section className="panel">
          <h2>Chat</h2>
          <p className="muted">Unified chat arrives in M2.</p>
        </section>
      </main>
      <StatusBar state={state} />
    </div>
  );
}
