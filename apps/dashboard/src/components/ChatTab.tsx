import { useState, type ReactNode } from 'react';
import type { Alert, ChatMessage } from '@streamhub/shared';
import { ChatPanel, type ChatTextSize } from './ChatPanel';

/** Chat with search and the "On screen now" bar on top: the body of the pop-out window. */
export function ChatTab({
  messages,
  featuredId,
  size,
  onFeature,
  onClearFeature,
  tools,
  alerts,
}: {
  messages: ChatMessage[];
  featuredId: string | null;
  size: ChatTextSize;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
  /** Extra buttons next to the search box. */
  tools?: ReactNode;
  alerts?: Alert[];
}) {
  const [query, setQuery] = useState('');
  const featured = featuredId ? messages.find((m) => m.id === featuredId) : undefined;
  return (
    <div className="chat-tab">
      <div className="chat-tools">
        <input
          type="search"
          className="chat-search"
          aria-label="Search chat"
          placeholder="Search messages or names"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tools}
      </div>
      <div className="featured-bar" aria-live="polite">
        {featuredId ? (
          <div className="featured-card">
            <div className="featured-top">
              <span>On screen now</span>
              <span className="spacer" />
              <button className="sm" onClick={onClearFeature}>
                Take down
              </button>
            </div>
            <div className="featured-text">
              {featured ? (
                <>
                  <strong>{featured.author.name}</strong> {featured.text}
                </>
              ) : (
                'A message is on screen'
              )}
            </div>
          </div>
        ) : (
          <p className="featured-hint">Nothing on screen. Hover a message and click Feature to show it on stream.</p>
        )}
      </div>
      <ChatPanel
        messages={messages}
        featuredId={featuredId}
        size={size}
        query={query}
        alerts={alerts}
        onFeature={onFeature}
        onClearFeature={onClearFeature}
      />
    </div>
  );
}
