import { useState } from 'react';
import type { ChatMessage } from '@streamhub/shared';
import type { ChatSize } from '../prefs';
import { ChatPanel } from './ChatPanel';

export function ChatTab({
  messages,
  featuredId,
  size,
  onFeature,
  onClearFeature,
}: {
  messages: ChatMessage[];
  featuredId: string | null;
  size: ChatSize;
  onFeature: (message: ChatMessage) => void;
  onClearFeature: () => void;
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
        <div className="featured-bar" aria-live="polite">
          {featuredId ? (
            <>
              <span className="badge">On screen</span>
              <span className="featured-text">
                {featured ? (
                  <>
                    <strong>{featured.author.name}</strong> {featured.text}
                  </>
                ) : (
                  'A message is featured'
                )}
              </span>
              <button onClick={onClearFeature}>Clear feature</button>
            </>
          ) : (
            <span className="small muted">Nothing featured. Hover a message and click Feature to put it on screen.</span>
          )}
        </div>
      </div>
      <ChatPanel
        messages={messages}
        featuredId={featuredId}
        size={size}
        query={query}
        onFeature={onFeature}
        onClearFeature={onClearFeature}
      />
    </div>
  );
}
