import { useState } from 'react';
import type { AudioState, ModulesList, Platform } from '@streamhub/shared';
import { PLATFORMS } from '../../platforms';
import type { DashboardState } from '../../state';
import { Icon } from '../Icon';
import { Panel, PageHead } from '../ui';

/** The chat platforms that bring chat and alerts; X only reports livestream state. */
const CHAT_PLATFORMS: Platform[] = ['twitch', 'youtube', 'kick'];

export type SetupStep = { id: 'obs' | 'mics' | 'platform' | 'onscreen'; title: string; done: boolean; detail: string };

/** The four once-only steps, derived from what the hub already reports. */
export function setupSteps(state: DashboardState, audio: AudioState | null): SetupStep[] {
  const connected = CHAT_PLATFORMS.filter((p) => state.connections[p]?.state === 'connected');
  const mics = audio?.mics.length ?? 0;
  return [
    {
      id: 'obs',
      title: 'Connect OBS',
      done: state.obs.connected,
      detail: state.obs.connected ? 'OBS is connected.' : 'OBS is not connected yet. Start OBS, then check the address.',
    },
    {
      id: 'mics',
      title: 'Add mics',
      done: mics > 0,
      detail: mics > 0 ? `${mics} ${mics === 1 ? 'mic' : 'mics'} set up.` : 'No mics yet. Each mic gets its own recording track.',
    },
    {
      id: 'platform',
      title: 'Connect a platform',
      done: connected.length > 0,
      detail:
        connected.length > 0
          ? `${connected.map((p) => PLATFORMS[p].label).join(', ')} ${connected.length === 1 ? 'is' : 'are'} connected.`
          : 'Brings chat and alerts in, and adds its stream key to OBS. Twitch is the quickest.',
    },
    {
      id: 'onscreen',
      title: 'Put alerts and chat on screen',
      done: false,
      detail: 'Copy the overlay links into OBS as Browser Sources. Done in OBS, so it stays open here.',
    },
  ];
}

/** The sidebar note "2 of 4" and the progress bar agree on this count. */
export const doneCount = (steps: SetupStep[]) => steps.filter((s) => s.done).length;

/** First-run guide: what is left before the first show, with the next step's button. */
export function SetupOverview({
  state,
  audio,
  modules,
  onOpen,
}: {
  state: DashboardState;
  audio: AudioState | null;
  modules: ModulesList | null;
  onOpen: (page: string) => void;
}) {
  const steps = setupSteps(state, audio);
  const done = doneCount(steps);
  const next = steps.find((s) => !s.done);
  const [showOverlays, setShowOverlays] = useState(false);
  const platformToOpen = CHAT_PLATFORMS.find((p) => ['error', 'pending'].includes(state.connections[p]?.state ?? '')) ?? 'twitch';
  const overlays = modules?.modules.flatMap((m) => (m.built ? m.overlays.map((o) => ({ ...o, module: m.name })) : [])) ?? [];

  return (
    <>
      <PageHead title="Setup overview">
        Everything streamhub needs before your first show. Each step takes a few minutes and is only done once.
      </PageHead>
      <div className="setup-progress">
        <div className="setup-bar">
          <i style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
        <b>
          {done} of {steps.length} done
        </b>
      </div>
      <Panel className="setup-steps" label="Setup steps">
        {steps.map((step, i) => (
          <div key={step.id} className={`setup-step ${step.done ? 'done' : ''} ${step.id === next?.id ? 'next' : ''}`}>
            <span className={`setup-check ${step.done ? 'done' : step.id === next?.id ? 'next' : 'todo'}`}>
              {step.done ? '✓' : step.id === next?.id ? null : i + 1}
            </span>
            <div className="setup-step-text">
              <h4>{step.title}</h4>
              <p>{step.detail}</p>
            </div>
            <div className="setup-step-action">
              {step.id === 'obs' && (
                <button className={step.done ? 'ghost' : 'primary big'} onClick={() => onOpen('obs')}>
                  {step.done ? 'Change' : 'Open OBS settings'}
                </button>
              )}
              {step.id === 'mics' && <span className="setup-hint">Sound tab (⌘2)</span>}
              {step.id === 'platform' && !step.done && (
                <button className="primary big" onClick={() => onOpen(platformToOpen)}>
                  {state.connections[platformToOpen]?.state === 'disconnected' && state.connections[platformToOpen]?.clientConfigured === false
                    ? `Set up ${PLATFORMS[platformToOpen].label}`
                    : `Connect ${PLATFORMS[platformToOpen].label}`}
                </button>
              )}
              {step.id === 'onscreen' && (
                <button className="big" aria-expanded={showOverlays} onClick={() => setShowOverlays((v) => !v)}>
                  Show me
                </button>
              )}
            </div>
          </div>
        ))}
        {showOverlays && (
          <div className="setup-overlays">
            {modules === null ? (
              <p className="muted small">Waiting for the hub.</p>
            ) : overlays.length === 0 ? (
              <p className="muted small">No overlay pages yet. Run pnpm build (or pnpm dev).</p>
            ) : (
              <>
                <p className="muted small">
                  In OBS: Sources → + → Browser. Paste a link and set the size to match. Chat goes on screen through the
                  pop-out window on the Live tab.
                </p>
                {overlays.map((o) => (
                  <div key={`${o.module}-${o.id}`} className="overlay-url">
                    <strong>{o.name}</strong>
                    <code className="small">{o.url}</code>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Copy ${o.name} URL`}
                      title="Copy URL"
                      onClick={() => void navigator.clipboard?.writeText(o.url)}
                    >
                      <Icon name="copy" />
                    </button>
                    <span className="small muted">
                      {o.width} × {o.height}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
