import { useEffect, useRef, useState } from 'react';
import { initialTab, rememberTab, TAB_IDS, type Prefs, type TabId } from '../prefs';

export const TAB_LABELS: Record<TabId, string> = { live: 'Live', sound: 'Sound', onscreen: 'On screen', settings: 'Settings' };

export const tabId = (tab: TabId) => `tab-${tab}`;
export const panelId = (tab: TabId) => `panel-${tab}`;

/** The current tab, remembered across reloads. ⌘1–4 switch tabs and ⌘, opens Settings. */
export function useTabs(prefs: Prefs): [TabId, (tab: TabId) => void] {
  const [tab, setTab] = useState<TabId>(() => initialTab(prefs));
  const select = useRef((next: TabId) => {
    setTab(next);
    rememberTab(next);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
      const n = Number(e.key);
      const next = e.key === ',' ? 'settings' : Number.isInteger(n) ? TAB_IDS[n - 1] : undefined;
      if (!next) return;
      e.preventDefault();
      select.current(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return [tab, select.current];
}

export function TabBar({
  tab,
  onSelect,
  attention = [],
}: {
  tab: TabId;
  onSelect: (tab: TabId) => void;
  attention?: TabId[];
}) {
  return (
    <nav className="segmented tabs" role="tablist" aria-label="Dashboard">
      {TAB_IDS.map((t, i) => (
        <button
          key={t}
          id={tabId(t)}
          role="tab"
          aria-selected={t === tab}
          aria-controls={panelId(t)}
          title={`${TAB_LABELS[t]} (⌘${i + 1})`}
          onClick={() => onSelect(t)}
        >
          {TAB_LABELS[t]}
          {attention.includes(t) && <span className="attention" aria-label="needs attention" />}
        </button>
      ))}
    </nav>
  );
}
