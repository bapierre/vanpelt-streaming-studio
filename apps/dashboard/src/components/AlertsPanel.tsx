import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ALERT_KINDS,
  ALERT_SOUNDS,
  renderAlertText,
  type Alert,
  type AlertKind,
  type AlertKindConfig,
  type AlertRecent,
  type AlertsConfig,
  type AlertSound,
  type ModulesList,
} from '@streamhub/shared';
import { Panel } from './ui';
import { ThrottledRange } from './ThrottledRange';

export const KIND_LABELS: Record<AlertKind, string> = {
  follow: 'Follows',
  sub: 'Subs and memberships',
  resub: 'Resubs',
  giftsub: 'Gift subs',
  cheer: 'Cheers (bits)',
  tip: 'Tips (Super Chats and Super Stickers)',
  raid: 'Raids',
};

/** The short word the overlay card shows above the message. */
const KIND_WORDS: Record<AlertKind, string> = {
  follow: 'Follow',
  sub: 'Sub',
  resub: 'Resub',
  giftsub: 'Gift sub',
  cheer: 'Cheer',
  tip: 'Tip',
  raid: 'Raid',
};

const SOUND_LABELS: Record<AlertSound, string> = {
  chime: 'Chime',
  pop: 'Pop',
  coin: 'Coin',
  fanfare: 'Fanfare',
  none: 'No sound',
};

/** Kinds that have a size, and what the minimum counts. */
const MIN_LABELS: Partial<Record<AlertKind, string>> = {
  giftsub: 'Smallest gift (subs)',
  cheer: 'Smallest cheer (bits)',
  tip: 'Smallest tip',
  raid: 'Smallest raid (viewers)',
};

/** How the row summary says "smaller ones do not pop up". */
const MIN_SUMMARY: Partial<Record<AlertKind, (n: number) => string>> = {
  cheer: (n) => `Only ${n} bits and up`,
  giftsub: (n) => `Only ${n} subs and up`,
  raid: (n) => `Only ${n} viewers and up`,
  tip: (n) => `Only tips of ${n} or more`,
};

const SAMPLE_USER = 'Test Viewer';

const SAMPLE: Record<AlertKind, Partial<Alert>> = {
  follow: {},
  sub: { tier: '1' },
  resub: { months: 12, tier: '1' },
  giftsub: { count: 5, tier: '1' },
  cheer: { amount: 500 },
  tip: { amount: 5, currency: 'USD' },
  raid: { count: 42 },
};

const PLATFORM_NAMES: Record<Alert['platform'], string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
};

export function previewText(template: string, kind: AlertKind): string {
  return renderAlertText(template, {
    id: 'preview',
    kind,
    platform: 'twitch',
    user: { id: 'preview', name: SAMPLE_USER },
    at: 0,
    ...SAMPLE[kind],
  });
}

/** The row's one-line settings summary: message template, sound, duration. */
export function kindSummary(cfg: AlertKindConfig, kind: AlertKind): string {
  const min =
    cfg.minAmount > 0 && MIN_SUMMARY[kind] ? `${MIN_SUMMARY[kind]!(cfg.minAmount)} · ` : '';
  return `${min}"${cfg.template}" · ${SOUND_LABELS[cfg.sound]} · ${cfg.durationMs / 1000} s`;
}

export type AlertActions = {
  onTest: (kind: AlertKind) => void;
  onReplay: (id: string) => void;
  onSkip: () => void;
  onPause: (paused: boolean) => void;
  onSetKind: (patch: Partial<AlertKindConfig> & { kind: AlertKind }) => void;
};

/** The pause switch in the Alerts page head. Paused alerts wait, then play in order. */
export function PauseAlerts({
  paused,
  disabled,
  onPause,
}: {
  paused: boolean;
  disabled: boolean;
  onPause: (paused: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="pause-button"
      aria-pressed={paused}
      disabled={disabled}
      title={
        paused
          ? 'Paused. New alerts wait until you resume.'
          : 'Hold new alerts until you resume, for example during an interview.'
      }
      onClick={() => onPause(!paused)}
    >
      {paused ? 'Resume alerts' : 'Pause alerts'}
    </button>
  );
}

/** Copies a link and does nothing when the browser has not granted a clipboard. */
export function CopyLink({ url, disabled }: { url: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="sm"
      title={url}
      disabled={disabled}
      onClick={() => void navigator.clipboard?.writeText(url)}
    >
      Copy link
    </button>
  );
}

/** One overlay URL to paste into OBS, with its size. */
export function OverlayUrl({
  name,
  url,
  width,
  height,
}: {
  name: string;
  url: string;
  width: number;
  height: number;
}) {
  return (
    <div className="overlay-url">
      <strong>{name}</strong>
      <code className="small">{url}</code>
      <CopyLink url={url} />
      <span className="small muted">
        {width} × {height}
      </span>
    </div>
  );
}

export function alertsModule(modules: ModulesList | null) {
  return modules?.modules.find((m) => m.id === 'alerts') ?? null;
}

/** Explains what to do when the overlay pages cannot be served yet. */
export function ModuleNotice({ modules }: { modules: ModulesList | null }) {
  const mod = alertsModule(modules);
  if (!modules) return <p className="notice muted small">Waiting for the hub.</p>;
  if (!mod)
    return (
      <p className="notice conn-error">
        The alerts overlays were not found. Check that the modules/alerts folder exists.
      </p>
    );
  if (!mod.built)
    return (
      <p className="notice conn-error">
        The alerts overlays are not built yet. Run pnpm build (or pnpm dev).
      </p>
    );
  return null;
}

/** One glyph per alert kind, drawn like the icons in the rest of the app. */
function KindIcon({ kind }: { kind: AlertKind }) {
  const paths: Record<AlertKind, ReactNode> = {
    follow: (
      <path d="M8 13.2C4.6 10.9 2.2 8.7 2.2 6.1 2.2 4.2 3.6 2.8 5.3 2.8 6.4 2.8 7.5 3.4 8 4.4 8.5 3.4 9.6 2.8 10.7 2.8 12.4 2.8 13.8 4.2 13.8 6.1 13.8 8.7 11.4 10.9 8 13.2Z" />
    ),
    sub: <path d="M8 1.8l1.9 4 4.4.5-3.2 3 .8 4.4L8 11.6l-3.9 2.1.8-4.4-3.2-3 4.4-.5z" />,
    resub: (
      <>
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2.5v3h-3" />
      </>
    ),
    giftsub: (
      <>
        <path d="M2 6h12" />
        <path d="M3.5 6v7h9V6" />
        <path d="M8 6v7" />
        <path d="M6.2 4.2C5 3.4 3.6 4.4 4.2 5.8 4.6 6.6 6 6.6 8 6" />
        <path d="M9.8 4.2c1.2-.8 2.6.2 2 1.6-.4.8-1.8.8-3.8 0" />
      </>
    ),
    cheer: (
      <>
        <path d="M5 2.5h6l2.5 3.5L8 13.5 2.5 6z" />
        <path d="M2.5 6h11" />
        <path d="M5.6 6 8 2.5 10.4 6" />
      </>
    ),
    tip: (
      <>
        <path d="M1.5 4h13v8h-13z" />
        <circle cx="8" cy="8" r="1.8" />
      </>
    ),
    raid: (
      <>
        <path d="M2.5 3.5v9" />
        <path d="M5 8h7.5" />
        <path d="M9.5 4.5 13 8l-3.5 3.5" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[kind]}
    </svg>
  );
}

function KindRow({
  kind,
  cfg,
  disabled,
  actions,
}: {
  kind: AlertKind;
  cfg: AlertKindConfig;
  disabled: boolean;
  actions: AlertActions;
}) {
  // Opening the row is local to the dashboard: it sends nothing to the hub.
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(cfg.template);
  const [min, setMin] = useState(String(cfg.minAmount));
  useEffect(() => setTemplate(cfg.template), [cfg.template]);
  useEffect(() => setMin(String(cfg.minAmount)), [cfg.minAmount]);
  const set = (patch: Partial<AlertKindConfig>) => actions.onSetKind({ kind, ...patch });
  const dirty = template.trim() !== cfg.template;
  const saveTemplate = (e: FormEvent) => {
    e.preventDefault();
    if (template.trim() && dirty) set({ template: template.trim() });
  };
  const commitMin = () => {
    const value = Number(min);
    if (Number.isFinite(value) && value >= 0 && value !== cfg.minAmount) set({ minAmount: value });
    else setMin(String(cfg.minAmount));
  };
  const id = (part: string) => `alert-${kind}-${part}`;
  const shown = template.trim() || cfg.template;

  return (
    <div
      className={`kind kind-${kind}${cfg.enabled ? '' : ' off'}${open ? ' open' : ''}`}
      data-testid={`alert-kind-${kind}`}
    >
      <div className="kind-row">
        <span className="kind-ico" aria-hidden>
          <KindIcon kind={kind} />
        </span>
        <span className="kind-name">
          <strong>{KIND_LABELS[kind]}</strong>
          <span className="kind-summary">{kindSummary(cfg, kind)}</span>
        </span>
        <button
          type="button"
          className="sm"
          disabled={disabled}
          onClick={() => actions.onTest(kind)}
        >
          Test
        </button>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={cfg.enabled}
          aria-label={KIND_LABELS[kind]}
          disabled={disabled}
          onClick={() => set({ enabled: !cfg.enabled })}
        />
        <button
          type="button"
          className="chevron"
          aria-expanded={open}
          aria-controls={id('settings')}
          aria-label={`${KIND_LABELS[kind]} settings`}
          onClick={() => setOpen(!open)}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="kind-expand" id={id('settings')}>
          <div className="kind-settings">
            <form className="control" onSubmit={saveTemplate}>
              <label htmlFor={id('template')}>Text</label>
              <input
                id={id('template')}
                className="alert-template"
                value={template}
                maxLength={200}
                disabled={disabled}
                onChange={(e) => setTemplate(e.target.value)}
              />
              <button
                type="submit"
                className="sm"
                disabled={disabled || !dirty || !template.trim()}
              >
                Save
              </button>
              <span className="small muted control-help">
                Placeholders: {'{user} {amount} {count} {months} {tier}'}
              </span>
            </form>
            <div className="control">
              <label htmlFor={id('sound')}>Sound</label>
              <select
                id={id('sound')}
                value={cfg.sound}
                disabled={disabled}
                onChange={(e) => set({ sound: e.target.value as AlertSound })}
              >
                {ALERT_SOUNDS.map((s) => (
                  <option key={s} value={s}>
                    {SOUND_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="control">
              <label htmlFor={id('volume')}>Volume</label>
              <ThrottledRange
                id={id('volume')}
                value={Math.round(cfg.volume * 100)}
                min={0}
                max={100}
                step={5}
                disabled={disabled || cfg.sound === 'none'}
                format={(v) => `${v}%`}
                onChange={(v) => set({ volume: v / 100 })}
              />
            </div>
            <div className="control">
              <label htmlFor={id('duration')}>On screen for</label>
              <ThrottledRange
                id={id('duration')}
                value={cfg.durationMs / 1000}
                min={2}
                max={30}
                step={1}
                disabled={disabled}
                format={(v) => `${v} s`}
                onChange={(v) => set({ durationMs: v * 1000 })}
              />
            </div>
            {MIN_LABELS[kind] && (
              <div className="control">
                <label htmlFor={id('min')}>{MIN_LABELS[kind]}</label>
                <input
                  id={id('min')}
                  className="alert-number"
                  type="number"
                  min={0}
                  step="any"
                  value={min}
                  disabled={disabled}
                  onChange={(e) => setMin(e.target.value)}
                  onBlur={commitMin}
                  onKeyDown={(e) => e.key === 'Enter' && commitMin()}
                />
                <span className="small muted control-help">
                  {kind === 'tip' ? 'In the tip’s own currency. ' : ''}0 shows every one. Smaller
                  ones still count toward goals.
                </span>
              </div>
            )}
          </div>
          {/* A CSS imitation of the overlay pop-up, with the sample name already filled in. */}
          <div className="kind-preview" aria-hidden>
            <div className="os-popup">
              <span className="avatar">{SAMPLE_USER[0]}</span>
              <span className="popup-body">
                <span className="os-popup-kind">{KIND_WORDS[kind]}</span>
                <span className="os-popup-text">{previewText(shown, kind)}</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AlertsPanel({
  config,
  recent,
  modules,
  twitchDetail,
  disabled,
  actions,
}: {
  config: AlertsConfig | null;
  recent: AlertRecent | null;
  modules: ModulesList | null;
  /** Twitch's status note, e.g. when follower alerts need a reconnect. */
  twitchDetail?: string;
  disabled: boolean;
  actions: AlertActions;
}) {
  const popup = alertsModule(modules)?.overlays.find((o) => o.id === 'popup');
  const off = disabled || !config;
  return (
    <>
      {twitchDetail?.startsWith('Reconnect Twitch') && (
        <p className="notice conn-error">{twitchDetail}</p>
      )}
      <Panel label="Overlay links" className="onscreen-panel">
        <ModuleNotice modules={modules} />
        {popup && (
          <>
            <OverlayUrl
              name="Alert pop-up"
              url={popup.url}
              width={popup.width}
              height={popup.height}
            />
            <p className="overlay-help small muted">
              Add it to OBS as a Browser Source and tick Control audio via OBS so the sounds reach
              the stream.
            </p>
          </>
        )}
      </Panel>
      {config ? (
        <Panel label="Alert types" className="onscreen-panel">
          {ALERT_KINDS.map((k) => (
            <KindRow key={k} kind={k} cfg={config.kinds[k]} disabled={disabled} actions={actions} />
          ))}
        </Panel>
      ) : (
        <Panel label="Alert types" className="onscreen-panel">
          <p className="notice muted small">Waiting for the hub.</p>
        </Panel>
      )}
      <Panel
        title="Recent alerts"
        label="Recent alerts"
        className="onscreen-panel"
        actions={
          <>
            {recent && recent.queued > 0 && <span className="badge">{recent.queued} waiting</span>}
            <button type="button" className="sm" disabled={off} onClick={actions.onSkip}>
              Skip current
            </button>
          </>
        }
      >
        {recent && recent.alerts.length > 0 ? (
          <ul className="recent-list">
            {recent.alerts.slice(0, 20).map((a) => (
              <li key={a.id} className="recent-row">
                <span className="small muted recent-time">{timeOf(a.at)}</span>
                <span className="small muted">{PLATFORM_NAMES[a.platform]}</span>
                <span className="recent-text">
                  {config ? renderAlertText(config.kinds[a.kind].template, a) : a.user.name}
                </span>
                {a.test && <span className="badge">Test</span>}
                <button
                  type="button"
                  className="sm"
                  disabled={off}
                  onClick={() => actions.onReplay(a.id)}
                >
                  Replay
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="notice muted small">No alerts yet.</p>
        )}
      </Panel>
    </>
  );
}
