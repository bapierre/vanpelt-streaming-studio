import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, Platform } from '@streamhub/shared';
import type { ChatSize } from '../prefs';
import { CHAT_PLATFORMS, PLATFORMS, platformColor } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';

type Props = {
  messages: ChatMessage[];
  featuredId: string | null;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
  /** Narrow column: no platform chips or role badges. */
  compact?: boolean;
  size?: ChatSize;
  /** Only messages whose text or author contains this (any case). */
  query?: string;
};

export function matchesQuery(m: ChatMessage, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || m.text.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q);
}

export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 40) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function Fragment({ f }: { f: ChatMessage['fragments'][number] }) {
  switch (f.kind) {
    case 'text':
      return <>{f.text}</>;
    case 'mention':
      return <strong className="mention">@{f.name}</strong>;
    case 'link':
      return <>{f.url}</>;
    case 'emote': {
      const src = safeHttpsUrl(f.url);
      return src ? <img className="emote" src={src} alt={f.name} title={f.name} /> : <>{f.name}</>;
    }
  }
}

export function ChatPanel({
  messages,
  featuredId,
  onFeature,
  onClearFeature,
  compact = false,
  size = 'medium',
  query = '',
}: Props) {
  const [hidden, setHidden] = useState<Set<Platform>>(new Set());
  // null while following the latest message; otherwise the id of the last
  // visible message when the user scrolled away (undefined if there was none).
  const [paused, setPaused] = useState<{ anchor: string | undefined } | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const visible = messages.filter(
    (m) => (compact || !hidden.has(m.platform)) && matchesQuery(m, query),
  );
  const pinned = paused === null;
  const anchorIndex = paused?.anchor === undefined ? -1 : visible.findIndex((m) => m.id === paused.anchor);
  const unseen = paused ? visible.length - (anchorIndex + 1) : 0;

  useLayoutEffect(() => {
    if (pinned && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [visible.length, visible.at(-1)?.id, pinned]);

  const onScroll = (el: HTMLOListElement) => {
    if (isNearBottom(el)) setPaused(null);
    else setPaused((prev) => prev ?? { anchor: visible.at(-1)?.id });
  };

  const toggle = (p: Platform) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <section className={`card chat size-${size}${compact ? ' compact' : ''}`} aria-label="Chat">
      <div className="chat-head">
        <h2>Chat</h2>
        {!compact && (
          <div className="filters">
            {CHAT_PLATFORMS.map((p) => (
              <button
                key={p}
                className={hidden.has(p) ? 'filter off' : 'filter'}
                style={platformColor(p)}
                aria-pressed={!hidden.has(p)}
                onClick={() => toggle(p)}
              >
                {PLATFORMS[p].label}
              </button>
            ))}
          </div>
        )}
      </div>
      {visible.length === 0 && (
        <p className="empty">
          {messages.length > 0
            ? 'No messages match.'
            : 'No messages yet. Connect a platform in Settings.'}
        </p>
      )}
      <ol className="chat-list" ref={list} onScroll={(e) => onScroll(e.currentTarget)}>
        {visible.map((m) => (
          <li key={m.id} className={m.id === featuredId ? 'chat-row featured' : 'chat-row'}>
            <span className="tag" style={platformColor(m.platform)}>
              {PLATFORMS[m.platform].label}
            </span>
            <span className="author" style={m.author.color ? { color: m.author.color } : undefined}>
              {m.author.name}
            </span>
            {!compact &&
              m.author.roles.map((r) => (
                <span key={r} className="role">
                  {r}
                </span>
              ))}
            <span className="text">
              {m.fragments.map((f, i) => (
                <Fragment key={i} f={f} />
              ))}
            </span>
            {m.id === featuredId ? (
              <button className="feature" onClick={onClearFeature}>
                Unfeature
              </button>
            ) : (
              <button className="feature" onClick={() => onFeature(m)}>
                Feature
              </button>
            )}
          </li>
        ))}
      </ol>
      {!pinned && (
        <button
          className="jump"
          onClick={() => {
            if (list.current) list.current.scrollTop = list.current.scrollHeight;
            setPaused(null);
          }}
        >
          Paused · {unseen} new · Jump to latest
        </button>
      )}
    </section>
  );
}
