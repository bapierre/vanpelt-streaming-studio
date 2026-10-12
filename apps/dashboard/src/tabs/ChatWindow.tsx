import { useCallback, useEffect, useState } from 'react';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { ChatMessage, Platform } from '@streamhub/shared';
import {
  isDesktop,
  loadWindowSize,
  nextWindowSize,
  saveWindowSize,
  setChatOnTop,
  useAnnounceChatWindow,
  type WindowTextSize,
} from '../chatWindow';
import { ChatTab } from '../components/ChatTab';
import { Pill } from '../components/ui';
import { PLATFORMS, platformColor } from '../platforms';
import { usePrefs } from '../prefs';
import { formatUptime } from '../state';
import { useAppearance } from '../theme';
import { useAlerts } from '../useAlerts';
import { useDashboardState } from '../useDashboardState';
import { useNow } from '../useNow';

const SIZE_NAMES: Record<WindowTextSize, string> = { medium: 'Medium', large: 'Large', xlarge: 'Extra large' };

function PinIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 2.5h4M7 2.5v4l-2.5 2.5h7L9 6.5v-4M8 9v4.5" />
    </svg>
  );
}

function Uptime({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return <span className="chat-window-uptime">{formatUptime(now - startedAt)}</span>;
}

/** The pop-out chat: one column you can drag next to OBS or onto another screen while streaming. */
export function ChatWindow({ client }: { client: HubClient }) {
  const state = useDashboardState(client);
  const { recent } = useAlerts(client);
  const [size, setSize] = useState<WindowTextSize>(loadWindowSize);
  const [onTop, setOnTop] = useState(false);
  // The pop-out keeps the dashboard's appearance, read from the same storage.
  const [{ appearance }] = usePrefs();
  useAppearance(appearance);
  useAnnounceChatWindow();
  useEffect(() => {
    document.title = 'Chat · streamhub';
  }, []);
  const onFeature = useCallback((message: ChatMessage) => client.publish('show.feature.set', { message }), [client]);
  const onClearFeature = useCallback(() => client.publish('show.feature.clear'), [client]);
  const onAir = state.obs.connected && state.stream.state === 'live';
  const viewers = (Object.keys(state.live) as Platform[]).flatMap((p) => {
    const live = state.live[p];
    return live?.broadcast === 'running' && live.viewers !== undefined ? [{ p, n: live.viewers }] : [];
  });

  const cycleSize = () => {
    const next = nextWindowSize(size);
    setSize(next);
    saveWindowSize(next);
  };
  const togglePin = () => {
    const next = !onTop;
    setChatOnTop(next).then(
      () => setOnTop(next),
      () => {},
    );
  };

  return (
    <div className="chat-window">
      <header className="chat-window-bar" data-tauri-drag-region="deep">
        <strong>Chat</strong>
        <span className="spacer" />
        {!state.hubConnected && (
          <Pill tone="warn" dot>
            Hub offline
          </Pill>
        )}
        {onAir && <Pill tone="live">ON AIR</Pill>}
      </header>
      <ChatTab
        messages={state.chat}
        featuredId={state.featuredId}
        size={size}
        alerts={recent?.alerts}
        onFeature={onFeature}
        onClearFeature={onClearFeature}
        tools={
          <>
            <button
              className="sm"
              title={`Text size: ${SIZE_NAMES[size]}. Click to change.`}
              aria-label={`Text size: ${SIZE_NAMES[size]}`}
              onClick={cycleSize}
            >
              Aa
            </button>
            {isDesktop() && (
              <button
                className={onTop ? 'sm pin on' : 'sm pin'}
                title="Keep on top of other windows"
                aria-label="Keep on top"
                aria-pressed={onTop}
                onClick={togglePin}
              >
                <PinIcon />
              </button>
            )}
          </>
        }
      />
      {(viewers.length > 0 || (onAir && state.stream.startedAt)) && (
        <footer className="chat-window-foot">
          {viewers.map(({ p, n }) => (
            <span key={p} className="chat-window-viewers" style={platformColor(p)}>
              <span className="filter-dot" aria-hidden />
              {PLATFORMS[p].label} {n.toLocaleString('en-US')}
            </span>
          ))}
          <span className="spacer" />
          {onAir && state.stream.startedAt && <Uptime startedAt={state.stream.startedAt} />}
        </footer>
      )}
    </div>
  );
}
