import type { ReactNode } from 'react';
import type { Platform } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';

// Brand glyphs (24×24) from the Simple Icons set (CC0).
const GLYPHS: Record<Platform, string> = {
  twitch:
    'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  youtube:
    'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  kick: 'M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
};

/** A rounded brand-coloured tile with the platform's own logo. */
export function PlatformLogo({ platform, size = 22 }: { platform: Platform; size?: number }) {
  const { label, color } = PLATFORMS[platform];
  return (
    <span
      className={`platform-logo ${platform}`}
      style={{ width: size, height: size, background: color, borderRadius: Math.round(size * 0.27) }}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} aria-hidden>
        <path d={GLYPHS[platform]} fill="currentColor" />
      </svg>
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'accent' | 'live';

/** A small status label. `dot` adds the coloured dot in front. */
export function Pill({ tone, dot, children }: { tone: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      {dot && <span className="dot" aria-hidden />}
      {children}
    </span>
  );
}

/** A white card with an optional header row (title, subtitle, actions on the right). */
export function Panel({
  title,
  sub,
  actions,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** Accessible name when the title is not plain text. */
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  const named = label ?? (typeof title === 'string' ? title : undefined);
  return (
    <section className={className ? `panel ${className}` : 'panel'} aria-label={named}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {sub && <span className="panel-sub">{sub}</span>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** The large title at the top of a Settings or On screen page. */
export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

/** A sidebar of grouped pages, the shared layout of Settings and On screen. */
export type NavPage = { id: string; label: string; group?: string; icon?: ReactNode; note?: ReactNode; attention?: boolean };

export function SideNav({
  pages,
  current,
  label,
  onSelect,
}: {
  pages: NavPage[];
  current: string;
  label: string;
  onSelect: (id: string) => void;
}) {
  const groups: { name?: string; pages: NavPage[] }[] = [];
  for (const p of pages) {
    const last = groups[groups.length - 1];
    if (last && last.name === p.group) last.pages.push(p);
    else groups.push({ name: p.group, pages: [p] });
  }
  return (
    <nav className="side-nav" aria-label={label}>
      {groups.map((g, i) => (
        <div className="side-nav-group" key={g.name ?? i}>
          {g.name && <h3>{g.name}</h3>}
          {g.pages.map((p) => (
            <button key={p.id} className="side-nav-item" aria-current={p.id === current ? 'page' : undefined} onClick={() => onSelect(p.id)}>
              {p.icon}
              <span className="side-nav-label">{p.label}</span>
              {p.attention ? <span className="attention" aria-label="needs attention" /> : p.note && <span className="side-nav-note">{p.note}</span>}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
