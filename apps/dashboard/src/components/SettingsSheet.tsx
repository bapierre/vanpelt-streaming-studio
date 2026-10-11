import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export type SettingsTab = { id: string; label: string; content: ReactNode; attention?: boolean };

export function SettingsSheet({ tabs, initial, onClose }: { tabs: SettingsTab[]; initial?: string; onClose: () => void }) {
  const [tab, setTab] = useState(initial ?? tabs[0]!.id);
  const sheet = useRef<HTMLDivElement>(null);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <h1 id="settings-title">Settings</h1>
          <div className="segmented" role="tablist" aria-label="Settings sections">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={t.id === current.id} onClick={() => setTab(t.id)}>
                {t.label}
                {t.attention && <span className="attention" aria-label="needs attention" />}
              </button>
            ))}
          </div>
          <button className="icon-button" aria-label="Close settings" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-body" role="tabpanel" aria-label={current.label}>
          {current.content}
        </div>
      </div>
    </div>
  );
}
