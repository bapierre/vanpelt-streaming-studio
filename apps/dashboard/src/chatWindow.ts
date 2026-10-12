import { useEffect, useState } from 'react';

export const CHAT_VIEW = 'chat';
const NAME = 'streamhub-chat';
const CHANNEL = 'streamhub.chat-window';

/** True when this page is the pop-out chat window rather than the dashboard. */
export const isChatWindow = () => new URLSearchParams(globalThis.location?.search).get('view') === CHAT_VIEW;

/** Opens the chat in its own window, or brings the open one to the front. */
export function openChatWindow() {
  const url = new URL(globalThis.location.href);
  url.search = `?view=${CHAT_VIEW}`;
  url.hash = '';
  const win = window.open(url.toString(), NAME, 'popup,width=420,height=760');
  win?.focus();
}

/**
 * Whether a chat window is open, so the Live tab can hand it the space. The window announces
 * itself over a BroadcastChannel and says goodbye on close; a dashboard that opens later asks.
 */
export function useChatWindowOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (e) => {
      if (e.data === 'open') setOpen(true);
      if (e.data === 'closed') setOpen(false);
    };
    ch.postMessage('ask');
    return () => ch.close();
  }, []);
  return open;
}

/** Run inside the chat window: answers the dashboard and says when it goes away. */
export function useAnnounceChatWindow() {
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (e) => e.data === 'ask' && ch.postMessage('open');
    ch.postMessage('open');
    const bye = () => ch.postMessage('closed');
    window.addEventListener('pagehide', bye);
    return () => {
      window.removeEventListener('pagehide', bye);
      bye();
      ch.close();
    };
  }, []);
}
