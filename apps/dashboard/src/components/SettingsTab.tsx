import { useState, type ReactNode } from 'react';
import type { ChatSize, Prefs, StartTab } from '../prefs';
import { ThrottledRange } from './ThrottledRange';

export type SettingsSection = { id: string; label: string; content: ReactNode; attention?: boolean };

/** Setup, one section at a time. Keys and codes stay masked inside each panel. */
export function SettingsTab({ sections, initial }: { sections: SettingsSection[]; initial?: string }) {
  const [id, setId] = useState(initial ?? sections[0]!.id);
  const current = sections.find((s) => s.id === id) ?? sections[0]!;
  return (
    <div className="settings">
      <nav className="settings-menu" aria-label="Settings sections">
        {sections.map((s) => (
          <button
            key={s.id}
            className="scene"
            aria-current={s.id === current.id ? 'page' : undefined}
            onClick={() => setId(s.id)}
          >
            <span className="scene-name">{s.label}</span>
            {s.attention && <span className="attention" aria-label="needs attention" />}
          </button>
        ))}
      </nav>
      <section className="settings-body" aria-label={current.label}>
        <h1>{current.label}</h1>
        {current.content}
      </section>
    </div>
  );
}

const START_LABELS: Record<StartTab, string> = { last: 'The last tab used', live: 'Live', sound: 'Sound', onscreen: 'On screen' };
const SIZE_LABELS: Record<ChatSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

export function GeneralSettings({
  targetDb,
  disabled,
  prefs,
  onTarget,
  onPrefs,
}: {
  /** Null until the hub has sent the audio state. */
  targetDb: number | null;
  disabled: boolean;
  prefs: Prefs;
  onTarget: (targetDb: number) => void;
  onPrefs: (change: Partial<Prefs>) => void;
}) {
  return (
    <>
      <section className="group">
        <div className="group-row form">
          <strong>Sound</strong>
          <div className="control">
            <label htmlFor="audio-target">Sound check target</label>
            <ThrottledRange
              id="audio-target"
              value={targetDb ?? -20}
              min={-40}
              max={-6}
              step={1}
              disabled={disabled || targetDb === null}
              format={(v) => `${v} dBFS`}
              onChange={onTarget}
            />
            <span className="small muted control-help">Speech level every mic is set to. −20 suits most shows.</span>
          </div>
        </div>
      </section>
      <section className="group">
        <div className="group-row form">
          <strong>This dashboard</strong>
          <p className="small muted">Saved in this browser only.</p>
          <div className="control">
            <label htmlFor="pref-start">Open on</label>
            <select id="pref-start" value={prefs.startTab} onChange={(e) => onPrefs({ startTab: e.target.value as StartTab })}>
              {(Object.keys(START_LABELS) as StartTab[]).map((t) => (
                <option key={t} value={t}>
                  {START_LABELS[t]}
                </option>
              ))}
            </select>
            <span className="small muted control-help">Settings is never reopened on its own, so a shared screen does not show it.</span>
          </div>
          <div className="control">
            <label htmlFor="pref-chat-size">Chat text size</label>
            <select id="pref-chat-size" value={prefs.chatSize} onChange={(e) => onPrefs({ chatSize: e.target.value as ChatSize })}>
              {(Object.keys(SIZE_LABELS) as ChatSize[]).map((s) => (
                <option key={s} value={s}>
                  {SIZE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </>
  );
}
