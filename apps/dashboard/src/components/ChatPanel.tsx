import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, Platform } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { safeHttpsUrl } from '../safeUrl';

type Props = {
  messages: ChatMessage[];
  featuredId: string | null;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
};

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

export function ChatPanel({ messages, featuredId, onFeature, onClearFeature }: Props) {
  const [hidden, setHidden] = useState<Set<Platform>>(new Set());
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const list = useRef<HTMLOListElement>(null);
  const lastCount = useRef(messages.length);

  const visible = messages.filter((m) => !hidden.has(m.platform));

  useLayoutEffect(() => {
    const added = Math.max(0, messages.length - lastCount.current);
    lastCount.current = messages.length;
    if (pinned && list.current) list.current.scrollTop = list.current.scrollHeight;
    else if (added) setUnseen((n) => n + added);
  }, [messages, pinned]);

  useEffect(() => {
    if (pinned) setUnseen(0);
  }, [pinned]);

  const toggle = (p: Platform) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <section className="panel chat">
      <div className="chat-head">
        <h2>Chat</h2>
        <div className="filters">
          {(Object.keys(PLATFORMS) as Platform[]).map((p) => (
            <button
              key={p}
              className={hidden.has(p) ? 'filter off' : 'filter'}
              style={{ borderColor: PLATFORMS[p].color }}
              aria-pressed={!hidden.has(p)}
              onClick={() => toggle(p)}
            >
              {PLATFORMS[p].label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 && <p className="muted">No messages yet. Connect a platform on the Connections page.</p>}
      <ol className="chat-list" ref={list} onScroll={(e) => setPinned(isNearBottom(e.currentTarget))}>
        {visible.map((m) => (
          <li key={m.id} className={m.id === featuredId ? 'chat-row featured' : 'chat-row'}>
            <span className="tag" style={{ background: PLATFORMS[m.platform].color }}>
              {PLATFORMS[m.platform].label}
            </span>
            <span className="author" style={m.author.color ? { color: m.author.color } : undefined}>
              {m.author.name}
            </span>
            {m.author.roles.map((r) => (
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
            setPinned(true);
          }}
        >
          Paused · {unseen} new · Jump to latest
        </button>
      )}
    </section>
  );
}
