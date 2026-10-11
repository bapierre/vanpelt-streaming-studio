import { useEffect, useId, useRef, useState } from 'react';
import { summarize, type Check, type CheckStatus, type Fix } from '../preflight';

const MARK: Record<CheckStatus, { symbol: string; word: string }> = {
  fail: { symbol: '×', word: 'Problem' },
  warn: { symbol: '!', word: 'Check' },
  ok: { symbol: '✓', word: 'OK' },
};
const ORDER: CheckStatus[] = ['fail', 'warn', 'ok'];

function Row({ check, onFix }: { check: Check; onFix: (fix: Fix) => void }) {
  const mark = MARK[check.status];
  return (
    <li className={`pf-row ${check.status}`}>
      <span className="pf-mark" aria-hidden>
        {mark.symbol}
      </span>
      <span className="pf-text">
        <span className="sr-only">{mark.word}: </span>
        {check.title}
        {check.detail && <span className="pf-detail">{check.detail}</span>}
      </span>
      {check.fix && (
        <button className="link" onClick={() => onFix(check.fix!)}>
          {check.fix.label}
        </button>
      )}
    </li>
  );
}

/** A toolbar button that sums up the pre-flight checks and opens the list. */
export function Preflight({ checks, onFix }: { checks: Check[]; onFix: (fix: Fix) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useId();
  const summary = summarize(checks);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sorted = [...checks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  return (
    <div className="preflight" ref={root}>
      <button
        className={`preflight-button ${summary.level}`}
        aria-expanded={open}
        aria-controls={panel}
        aria-label={`Pre-flight: ${summary.label}`}
        title="Pre-flight checks"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dot" aria-hidden />
        {summary.label}
      </button>
      {open && (
        <section className="preflight-panel" id={panel} aria-label="Pre-flight checks">
          <h2>Pre-flight</h2>
          <ul>
            {sorted.map((c) => (
              <Row
                key={c.id}
                check={c}
                onFix={(fix) => {
                  setOpen(false);
                  onFix(fix);
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
