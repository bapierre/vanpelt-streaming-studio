import { useCallback, useEffect } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { ChatMessage } from '@streamhub/shared';
import { useAnnounceChatWindow } from '../chatWindow';
import { ChatTab } from '../components/ChatTab';
import { Pill } from '../components/ui';
import { usePrefs } from '../prefs';
import { useDashboardState } from '../useDashboardState';

/** The pop-out chat: one column you can drag next to OBS or onto another screen while streaming. */
export function ChatWindow({ client }: { client: HubClient }) {
  const state = useDashboardState(client);
  const [prefs] = usePrefs();
  useAnnounceChatWindow();
  useEffect(() => {
    document.title = 'Chat · streamhub';
  }, []);
  const onFeature = useCallback((message: ChatMessage) => client.publish('show.feature.set', { message }), [client]);
  const onClearFeature = useCallback(() => client.publish('show.feature.clear'), [client]);
  const onAir = state.obs.connected && state.stream.state === 'live';
  return (
    <div className="chat-window">
      <header className="chat-window-bar" data-tauri-drag-region="deep">
        <strong>Chat</strong>
        <span className="spacer" />
        {!state.hubConnected && <Pill tone="warn" dot>Hub offline</Pill>}
        {onAir && <Pill tone="live">On air</Pill>}
      </header>
      <ChatTab
        messages={state.chat}
        featuredId={state.featuredId}
        size={prefs.chatSize === 'small' ? 'medium' : 'large'}
        onFeature={onFeature}
        onClearFeature={onClearFeature}
      />
    </div>
  );
}
