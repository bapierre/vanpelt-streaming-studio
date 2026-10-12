import type { Alert, MicState } from '@streamhub/shared';
import { micWarning } from '../audio';
import { openChatWindow, useChatWindowOpen } from '../chatWindow';
import type { LevelsStore } from '../levels';
import { usePreviewPref } from '../previewPrefs';
import { formatUptime } from '../state';
import { useNow } from '../useNow';
import { Fader, LiveMeter, MuteButton, type AudioActions } from '../components/AudioPanel';
import { CameraSwitcher } from '../components/CamerasPanel';
import { ChatPanel } from '../components/ChatPanel';
import { RecordingPanel } from '../components/RecordingPanel';
import { ScenePanel } from '../components/ScenePanel';
import { SourcesPanel } from '../components/SourcesPanel';
import { Panel, Pill } from '../components/ui';
import { useDocumentVisible, usePreviewLease } from '../usePreviews';
import type { DashboardState } from '../state';
import type { Prefs } from '../prefs';
import type { Studio } from '../useStudio';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });

/** Tips of this stream: one number when they share a currency, otherwise a count. */
function tipTotal(alerts: Alert[]): string {
  const tips = alerts.filter((a) => a.kind === 'tip');
  if (tips.length === 0) return '0';
  const currencies = new Set(tips.map((a) => a.currency));
  const total = tips.reduce((sum, a) => sum + (a.amount ?? 0), 0);
  const currency = tips[0]!.currency;
  if (currencies.size === 1 && currency) {
    try {
      return total.toLocaleString('en-US', { style: 'currency', currency });
    } catch {
      return String(total);
    }
  }
  return currencies.size === 1 ? total.toLocaleString('en-US') : String(tips.length);
}

/**
 * What the stream is doing right now, from real data only: viewers reported by the running
 * platforms, OBS's stream uptime, and this stream's follows, subs and tips. The alert counts come
 * from `alert.recent`, which keeps the last 50, so a very busy hour undercounts; that is the
 * honest number available without new hub work.
 */
function StatsStrip({ state, alerts }: { state: DashboardState; alerts: Alert[] }) {
  const now = useNow(1000);
  const running = Object.values(state.live).filter((l) => l?.broadcast === 'running');
  const withViewers = running.filter((l) => l?.viewers !== undefined);
  const viewers = withViewers.reduce((sum, l) => sum + (l?.viewers ?? 0), 0);
  const startedAt = state.stream.state === 'live' ? state.stream.startedAt : undefined;
  const since = startedAt !== undefined ? alerts.filter((a) => !a.test && a.at >= startedAt) : [];
  const follows = since.filter((a) => a.kind === 'follow').length;
  const subs = since.reduce(
    (sum, a) => sum + (a.kind === 'sub' || a.kind === 'resub' ? 1 : a.kind === 'giftsub' ? (a.count ?? 1) : 0),
    0,
  );
  return (
    <section className="stats" aria-label="Stream stats">
      <div className="stat">
        <div className="n">{withViewers.length > 0 ? compact.format(viewers) : '0'}</div>
        <div className="l">Viewers</div>
      </div>
      <div className="stat">
        <div className="n">{startedAt !== undefined ? formatUptime(now - startedAt) : '0:00:00'}</div>
        <div className="l">Uptime</div>
      </div>
      <div className="stat">
        <div className="n">+{compact.format(follows)}</div>
        <div className="l">New follows</div>
      </div>
      <div className="stat">
        <div className="n">{subs}</div>
        <div className="l">Subs</div>
      </div>
      <div className="stat">
        <div className="n">{tipTotal(since)}</div>
        <div className="l">Tips</div>
      </div>
    </section>
  );
}

/** One mic in the Live tab: status, mute, meter, fader, and a plain fix line when something is wrong. */
function MicStrip({
  mic,
  levels,
  disabled,
  actions,
}: {
  mic: MicState;
  levels: LevelsStore;
  disabled: boolean;
  actions: AudioActions;
}) {
  const warning = micWarning(mic);
  const off = disabled || mic.status !== 'ok';
  // Nesting puts the mics scene into every scene, which is exactly what clears this warning.
  const fixable = mic.status === 'ok' && !mic.live && !mic.detail;
  return (
    <div className="mic-strip">
      <div className="mic-strip-head">
        <span className={mic.live && mic.status === 'ok' ? 'dot ok' : 'dot'} aria-hidden />
        <span className="mic-strip-name">{mic.name}</span>
        {mic.live && mic.status === 'ok' && <Pill tone="live">On air</Pill>}
        <span className="spacer" />
        <MuteButton mic={mic} disabled={off} onSet={actions.onSet} />
      </div>
      <LiveMeter store={levels} id={mic.id} />
      <div className="control">
        <Fader mic={mic} disabled={off} onSet={actions.onSet} />
      </div>
      {warning && (
        <p className="mic-fix">
          <span className="dot warn" aria-hidden />
          <span className="mic-fix-text">{warning}</span>
          {fixable && (
            <button className="sm" disabled={disabled} onClick={actions.onNest}>
              Add to all scenes
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function LiveTab({ studio, prefs }: { studio: Studio; prefs: Prefs }) {
  const { client, state, cameras, recording, audio, levels, audioActions, obsReady, previews } = studio;
  const chatOut = useChatWindowOpen();
  const [previewsOn, setPreviewsOn] = usePreviewPref();
  const visible = useDocumentVisible();
  // The lease lives here: this tab only mounts while the Live tab is shown, so OBS renders
  // thumbnails only while someone can see them.
  usePreviewLease(client, visible && previewsOn);
  return (
    <div className={chatOut ? 'live chat-out' : 'live'}>
      <div className="live-col">
        <CameraSwitcher cameras={cameras} disabled={!obsReady} onTake={studio.takeCamera} />
        <ScenePanel
          scenes={state.scenes}
          current={state.currentScene}
          disabled={!obsReady}
          previews={previews}
          previewsOn={previewsOn}
          onTogglePreviews={setPreviewsOn}
          onSelect={(scene) => client.publish('obs.cmd.setScene', { scene })}
        />
        <SourcesPanel
          sources={state.sources}
          disabled={!obsReady}
          onToggle={(scene, source, visible) => client.publish('obs.cmd.setSourceVisible', { scene, source, visible })}
        />
        <RecordingPanel recording={recording} />
      </div>
      <div className="live-col" role="region" aria-label="Stream">
        <StatsStrip state={state} alerts={studio.alerts.recent?.alerts ?? []} />
        <Panel title="Mics">
          {audio.state && audio.state.mics.length > 0 ? (
            <div className="mic-strips">
              {audio.state.mics.map((mic) => (
                <MicStrip key={mic.id} mic={mic} levels={levels} disabled={!obsReady} actions={audioActions} />
              ))}
            </div>
          ) : (
            <p className="panel-empty">No mics yet. Add them in the Sound tab.</p>
          )}
        </Panel>
      </div>
      {chatOut ? (
        <Panel className="live-chat-out" title="Chat">
          <p className="panel-empty">Chat is in its own window.</p>
          <div className="panel-foot">
            <button onClick={openChatWindow} title="Bring the chat window to the front (⌘⇧C)">
              Show chat window
            </button>
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
