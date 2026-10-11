import { useEffect, useState, type FormEvent } from 'react';
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
import { Icon } from './Icon';
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
    user: { id: 'preview', name: 'Test Viewer' },
    at: 0,
    ...SAMPLE[kind],
  });
}

export type AlertActions = {
  onTest: (kind: AlertKind) => void;
  onReplay: (id: string) => void;
  onSkip: () => void;
  onPause: (paused: boolean) => void;
  onSetKind: (patch: Partial<AlertKindConfig> & { kind: AlertKind }) => void;
};

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
      <button
        type="button"
        className="icon-button"
        aria-label={`Copy ${name} URL`}
        title="Copy URL"
        onClick={() => void navigator.clipboard?.writeText(url)}
      >
        <Icon name="copy" />
      </button>
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
  if (!modules) return <p className="muted small">Waiting for the hub.</p>;
  if (!mod)
    return (
      <p className="conn-error">
        The alerts overlays were not found. Check that the modules/alerts folder exists.
      </p>
    );
  if (!mod.built)
    return (
      <p className="conn-error">
        The alerts overlays are not built yet. Run pnpm build (or pnpm dev).
      </p>
    );
  return null;
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

  return (
    <div className="group-row form alert-kind" data-testid={`alert-kind-${kind}`}>
      <div className="destination-head">
        <label className="alert-toggle">
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={disabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <strong>{KIND_LABELS[kind]}</strong>
        </label>
        <span className="spacer" />
        <button type="button" disabled={disabled} onClick={() => actions.onTest(kind)}>
          Test
        </button>
      </div>
      <details className="mic-filters">
        <summary>Text, sound and timing</summary>
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
          <button type="submit" disabled={disabled || !dirty || !template.trim()}>
            Save
          </button>
          <span className="small control-help">
            Preview: {previewText(template.trim() || cfg.template, kind)}
          </span>
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
              {kind === 'tip' ? 'In the tip’s own currency. ' : ''}0 shows every one. Smaller ones
              still count toward goals.
            </span>
          </div>
        )}
      </details>
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
      <p className="muted small">
        Follows, subs, gift subs, cheers, Super Chats and raids from Twitch and YouTube pop up one
        at a time with a sound. Add the pop-up to OBS as a Browser Source. Test alerts show on the
        overlay but never count toward a goal.
      </p>
      <ModuleNotice modules={modules} />
      {twitchDetail?.startsWith('Reconnect Twitch') && <p className="conn-error">{twitchDetail}</p>}
      <section className="group">
        {popup && (
          <div className="group-row">
            <OverlayUrl
              name="Alert pop-up"
              url={popup.url}
              width={popup.width}
              height={popup.height}
            />
          </div>
        )}
        <div className="group-row">
          <label className="alert-toggle">
            <input
              type="checkbox"
              checked={config?.paused ?? false}
              disabled={off}
              onChange={(e) => actions.onPause(e.target.checked)}
            />
            Pause alerts
          </label>
          <span className="small muted">
            {config?.paused ? 'New alerts wait until you resume.' : ''}
          </span>
          <span className="spacer" />
          {recent && recent.queued > 0 && <span className="badge">{recent.queued} waiting</span>}
          <button type="button" disabled={off} onClick={actions.onSkip}>
            Skip current
          </button>
        </div>
      </section>

      <h2 className="settings-sub">Alert types</h2>
      {config ? (
        <section className="group">
          {ALERT_KINDS.map((k) => (
            <KindRow key={k} kind={k} cfg={config.kinds[k]} disabled={off} actions={actions} />
          ))}
        </section>
      ) : (
        <p className="muted small">Waiting for the hub.</p>
      )}

      <h2 className="settings-sub">Recent alerts</h2>
      {recent && recent.alerts.length > 0 ? (
        <ul className="group alert-recent">
          {recent.alerts.slice(0, 20).map((a) => (
            <li key={a.id} className="group-row">
              <span className="small muted">{timeOf(a.at)}</span>
              <span className="small muted">{PLATFORM_NAMES[a.platform]}</span>
              <span className="alert-recent-text">
                {config ? renderAlertText(config.kinds[a.kind].template, a) : a.user.name}
              </span>
              {a.test && <span className="badge">Test</span>}
              <span className="spacer" />
              <button type="button" disabled={off} onClick={() => actions.onReplay(a.id)}>
                Replay
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No alerts yet.</p>
      )}
    </>
  );
}
