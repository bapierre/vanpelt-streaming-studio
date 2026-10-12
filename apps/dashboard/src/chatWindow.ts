import { useEffect, useState } from 'react';

export const CHAT_VIEW = 'chat';
const NAME = 'streamhub-chat';
const CHANNEL = 'streamhub.chat-window';

/** True when this page is the pop-out chat window rather than the dashboard. */
export const isChatWindow = () => new URLSearchParams(globalThis.location?.search).get('view') === CHAT_VIEW;

/** Text sizes for the pop-out window. It is read from a distance, so it starts larger than the Live column. */
export const WINDOW_SIZES = ['large', 'xlarge', 'medium'] as const;
export type WindowTextSize = (typeof WINDOW_SIZES)[number];
const SIZE_KEY = 'streamhub.chatWindow.size';

/** Private windows and locked-down webviews can throw on storage access; the size is only a convenience. */
export function loadWindowSize(): WindowTextSize {
  try {
    const saved = window.localStorage.getItem(SIZE_KEY);
    return WINDOW_SIZES.includes(saved as WindowTextSize) ? (saved as WindowTextSize) : 'large';
  } catch {
    return 'large';
  }
}

export function saveWindowSize(size: WindowTextSize) {
  try {
    window.localStorage.setItem(SIZE_KEY, size);
  } catch {
    // Not saved; the window still works.
  }
}

export const nextWindowSize = (size: WindowTextSize): WindowTextSize =>
  WINDOW_SIZES[(WINDOW_SIZES.indexOf(size) + 1) % WINDOW_SIZES.length]!;

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const tauri = () => (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

/** True inside the desktop app, where the chat window can stay on top of other apps. */
export const isDesktop = () => tauri() !== undefined;

/**
 * Keeps the desktop chat window above OBS. This is the call @tauri-apps/api's setAlwaysOnTop makes;
 * the chat-window capability in apps/desktop/src-tauri/tauri.conf.json allows it for that window only.
 */
export function setChatOnTop(value: boolean): Promise<unknown> {
  const t = tauri();
  if (!t) return Promise.resolve();
  return t.invoke('plugin:window|set_always_on_top', { label: CHAT_VIEW, value });
}

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
