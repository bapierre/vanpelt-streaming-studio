import { useState } from 'react';

export type TabId = 'live' | 'sound' | 'onscreen' | 'settings';
export const TAB_IDS: TabId[] = ['live', 'sound', 'onscreen', 'settings'];

/** Where the dashboard opens. Settings is never a choice, so a shared screen never opens on keys and codes. */
export type StartTab = 'last' | Exclude<TabId, 'settings'>;
export type ChatSize = 'small' | 'medium' | 'large';
export type Prefs = { startTab: StartTab; chatSize: ChatSize };

export const DEFAULT_PREFS: Prefs = { startTab: 'last', chatSize: 'medium' };
const PREFS_KEY = 'streamhub.prefs';
const LAST_TAB_KEY = 'streamhub.lastTab';

const START_TABS: StartTab[] = ['last', 'live', 'sound', 'onscreen'];
const CHAT_SIZES: ChatSize[] = ['small', 'medium', 'large'];

/** Private windows and locked-down webviews can throw on storage access; preferences are only a convenience. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Not saved; the dashboard still works.
  }
}

export function loadPrefs(): Prefs {
  let saved: Partial<Record<keyof Prefs, unknown>> = {};
  try {
    saved = JSON.parse(read(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    // A broken value falls back to the defaults.
  }
  return {
    startTab: START_TABS.includes(saved.startTab as StartTab) ? (saved.startTab as StartTab) : DEFAULT_PREFS.startTab,
    chatSize: CHAT_SIZES.includes(saved.chatSize as ChatSize) ? (saved.chatSize as ChatSize) : DEFAULT_PREFS.chatSize,
  };
}

export function savePrefs(prefs: Prefs) {
  write(PREFS_KEY, JSON.stringify(prefs));
}

export function rememberTab(tab: TabId) {
  write(LAST_TAB_KEY, tab);
}

export function initialTab(prefs: Prefs): TabId {
  if (prefs.startTab !== 'last') return prefs.startTab;
  const last = read(LAST_TAB_KEY);
  // 'chat' was a tab before chat moved into the Live column and its own window.
  return last === 'sound' || last === 'onscreen' ? last : 'live';
}

export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = (change: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...change };
      savePrefs(next);
      return next;
    });
  return [prefs, update];
}
