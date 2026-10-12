import { Mixer } from '../components/AudioPanel';
import { CameraSwitcher } from '../components/CamerasPanel';
import { ChatPanel } from '../components/ChatPanel';
import { RecordingPanel } from '../components/RecordingPanel';
import { ScenePanel } from '../components/ScenePanel';
import { SourcesPanel } from '../components/SourcesPanel';
import { Panel } from '../components/ui';
import { openChatWindow, useChatWindowOpen } from '../chatWindow';
import type { Prefs } from '../prefs';
import type { Studio } from '../useStudio';

export function LiveTab({ studio, prefs }: { studio: Studio; prefs: Prefs }) {
  const { client, state, cameras, recording, audio, levels, audioActions, obsReady } = studio;
  const chatOut = useChatWindowOpen();
  return (
    <div className={chatOut ? 'live chat-out' : 'live'}>
      <div className="live-col">
        <CameraSwitcher cameras={cameras} disabled={!obsReady} onTake={studio.takeCamera} />
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
      </div>
      <div className="live-col live-mixer" aria-label="Mixer" role="region">
        {audio.state && audio.state.mics.length > 0 ? (
          <Mixer mics={audio.state.mics} levels={levels} disabled={!obsReady} onSet={audioActions.onSet} />
        ) : (
          <Panel title="Mics">
            <p className="panel-empty">No mics yet. Add them in the Sound tab.</p>
          </Panel>
        )}
      </div>
      {chatOut ? (
        <Panel className="live-chat-out" title="Chat">
          <p className="panel-empty">Chat is in its own window.</p>
          <div className="panel-foot">
            <button onClick={openChatWindow}>Show chat window</button>
          </div>
        </Panel>
      ) : (
        <div className="live-chat">
          <ChatPanel
            compact
            size={prefs.chatSize}
            messages={state.chat}
            featuredId={state.featuredId}
            onFeature={studio.onFeature}
            onClearFeature={studio.onClearFeature}
            onPopOut={openChatWindow}
          />
        </div>
      )}
    </div>
  );
}
