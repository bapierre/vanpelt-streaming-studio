import type { Appearance, ChatSize, Prefs, StartTab } from '../../prefs';
import { ThrottledRange } from '../ThrottledRange';

const START_LABELS: Record<StartTab, string> = { last: 'The last tab used', live: 'Live', sound: 'Sound', onscreen: 'On screen' };
const SIZE_LABELS: Record<ChatSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
const APPEARANCE_LABELS: Record<Appearance, string> = { system: 'Match the system', light: 'Light', dark: 'Dark' };

/** Sound check target and this browser's dashboard preferences. */
export function PreferencesPage({
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
            <label htmlFor="pref-appearance">Appearance</label>
            <select
              id="pref-appearance"
              value={prefs.appearance}
              onChange={(e) => onPrefs({ appearance: e.target.value as Appearance })}
            >
              {(Object.keys(APPEARANCE_LABELS) as Appearance[]).map((a) => (
                <option key={a} value={a}>
                  {APPEARANCE_LABELS[a]}
                </option>
              ))}
            </select>
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
