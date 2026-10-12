import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Alert, ChatMessage, Platform } from '@streamhub/shared';
import type { ChatSize } from '../prefs';
import { CHAT_PLATFORMS, PLATFORMS, platformColor } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';
import { Icon } from './Icon';
import { PlatformLogo } from './ui';

export type ChatTextSize = ChatSize | 'xlarge';

type Props = {
  messages: ChatMessage[];
  featuredId: string | null;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
  /** Narrow Live column: tighter rows and an "On screen" bar at the bottom. */
  compact?: boolean;
  size?: ChatTextSize;
  /** Only messages whose text or author contains this (any case). */
  query?: string;
  /** Shows a "Pop out" button that moves chat into its own window. */
  onPopOut?: () => void;
  /** Follows, subs, raids and the like, shown between the messages by time. */
  alerts?: Alert[];
};

/** Normalize once per keystroke, not once per message per render. */
export const normalizeQuery = (query: string) => query.trim().toLowerCase();

/** `q` must already be normalized (see normalizeQuery). */
export function matchesQuery(m: ChatMessage, q: string): boolean {
  return !q || m.text.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q);
}

export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 40) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

const ROLE_LABELS: Record<ChatMessage['author']['roles'][number], string> = {
  owner: 'owner',
  moderator: 'mod',
  vip: 'vip',
  subscriber: 'sub',
  member: 'member',
};

/** What the alert says after the name, e.g. "subscribed for 6 months". */
export function alertPhrase(a: Alert): string {
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-US');
  switch (a.kind) {
    case 'follow':
      return 'followed';
    case 'sub':
      return 'subscribed';
    case 'resub':
      return a.months ? `subscribed for ${a.months} months` : 'subscribed again';
    case 'giftsub':
      return a.count === 1 ? 'gifted a sub' : `gifted ${n(a.count)} subs`;
    case 'cheer':
      return `cheered ${n(a.amount)} bits`;
    case 'tip':
      return `tipped ${a.amountText ?? (a.currency ? `${a.amount ?? 0} ${a.currency}` : n(a.amount))}`;
    case 'raid':
      return `raided with ${n(a.count)} viewers`;
  }
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
      return src ? <img className="emote" src={src} alt={f.name} title={f.name} decoding="async" loading="lazy" /> : <>{f.name}</>;
    }
  }
}

/** One row, memoized: a burst of new messages must not re-render the 299 already on screen. */
const ChatRow = memo(function ChatRow({
  m,
  featured,
  onFeature,
  onClearFeature,
}: {
  m: ChatMessage;
  featured: boolean;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
}) {
  return (
    <li className={featured ? 'chat-row featured' : 'chat-row'}>
      <PlatformLogo platform={m.platform} size={18} />
      <div className="chat-row-body">
        <div className="chat-row-who">
          <span className="author" style={m.author.color ? { color: m.author.color } : undefined}>
            {m.author.name}
          </span>
          {m.author.roles.map((r) => (
            <span key={r} className="role">
              {ROLE_LABELS[r]}
            </span>
          ))}
        </div>
        <div className="text">
          {m.fragments.map((f, i) => (
            <Fragment key={i} f={f} />
          ))}
        </div>
      </div>
      {featured ? (
        <button className="feature" onClick={onClearFeature}>
          Unfeature
        </button>
      ) : (
        <button className="feature" onClick={() => onFeature(m)}>
          Feature
        </button>
      )}
    </li>
  );
});

const AlertRow = memo(function AlertRow({ a }: { a: Alert }) {
  return (
    <li className="chat-alert" style={platformColor(a.platform)}>
      <PlatformLogo platform={a.platform} size={18} />
      <span className="chat-alert-text">
        <strong>{a.user.name}</strong> {alertPhrase(a)}
        {a.test && <span className="role">test</span>}
      </span>
    </li>
  );
});

type Item = { kind: 'message'; at: number; m: ChatMessage } | { kind: 'alert'; at: number; a: Alert };

export const ChatPanel = memo(function ChatPanel({
  messages,
  featuredId,
  onFeature,
  onClearFeature,
  compact = false,
  size = 'medium',
  query = '',
  onPopOut,
  alerts,
}: Props) {
  const [hidden, setHidden] = useState<Set<Platform>>(new Set());
  // null while following the latest message; otherwise the id of the last
  // visible message when the user scrolled away (undefined if there was none).
  const [paused, setPaused] = useState<{ anchor: string | undefined } | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const q = normalizeQuery(query);
  const visible = useMemo(() => messages.filter((m) => !hidden.has(m.platform) && matchesQuery(m, q)), [messages, hidden, q]);
  // Alerts only ever start after the oldest message on screen, so a quiet chat does not open on a wall of old follows.
  const items = useMemo<Item[]>(() => {
    const rows: Item[] = visible.map((m) => ({ kind: 'message', at: m.sentAt, m }));
    if (!alerts?.length) return rows;
    const since = messages[0]?.sentAt ?? -Infinity;
    for (const a of alerts) {
      if (a.at < since || hidden.has(a.platform) || (q && !a.user.name.toLowerCase().includes(q))) continue;
      rows.push({ kind: 'alert', at: a.at, a });
    }
    return rows.sort((x, y) => x.at - y.at);
  }, [visible, alerts, messages, hidden, q]);

  const pinned = paused === null;
  // A missing anchor fell out of the trimmed window (or was deleted): count from
  // just below the first visible message instead of calling all of them new.
  const anchorIndex = paused?.anchor === undefined ? -1 : Math.max(0, visible.findIndex((m) => m.id === paused.anchor));
  const unseen = paused ? visible.length - (anchorIndex + 1) : 0;
  const featured = featuredId ? messages.find((m) => m.id === featuredId) : undefined;

  useLayoutEffect(() => {
    if (pinned && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [items.length, visible.at(-1)?.id, pinned]);

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
    <section className={`chat chat-panel size-${size}${compact ? ' compact' : ''}`} aria-label="Chat">
      <div className="chat-head">
        <h2>Chat</h2>
        <span className="spacer" />
        {onPopOut && (
          <button className="sm" title="Open chat in its own window" onClick={onPopOut}>
            <Icon name="popout" />
            Pop out
          </button>
        )}
      </div>
      <div className="filters" role="group" aria-label="Show platforms">
        {CHAT_PLATFORMS.map((p) => (
          <button
            key={p}
            className={hidden.has(p) ? 'filter off' : 'filter'}
            style={platformColor(p)}
            aria-pressed={!hidden.has(p)}
            onClick={() => toggle(p)}
          >
            <span className="filter-dot" aria-hidden />
            {PLATFORMS[p].label}
          </button>
        ))}
      </div>
      <div className="chat-body">
        {items.length === 0 && (
          <div className="chat-empty">
            {messages.length > 0 ? (
              <p>No messages match.</p>
            ) : (
              <>
                <p className="chat-empty-title">No messages yet</p>
                <p>Connect Twitch, YouTube or Kick in Settings. Chat from every platform shows up here.</p>
              </>
            )}
          </div>
        )}
        <ol className="chat-list" ref={list} onScroll={(e) => onScroll(e.currentTarget)}>
          {items.map((it) =>
            it.kind === 'message' ? (
              <ChatRow key={it.m.id} m={it.m} featured={it.m.id === featuredId} onFeature={onFeature} onClearFeature={onClearFeature} />
            ) : (
              <AlertRow key={`alert:${it.a.id}`} a={it.a} />
            ),
          )}
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
      </div>
      {compact && featuredId && (
        <div className="chat-onscreen" aria-live="polite">
          <span className="dot" aria-hidden />
          <span className="chat-onscreen-text">
            {featured ? `On screen: ${featured.author.name}'s message` : 'On screen: a chat message'}
          </span>
          <button className="sm" onClick={onClearFeature}>
            Take down
          </button>
        </div>
      )}
    </section>
  );
});
