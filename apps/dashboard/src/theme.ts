import { useEffect } from 'react';
import type { Appearance } from './prefs';

/**
 * Light and dark are one dataset on <html>, not a CSS media query, so the Appearance preference can
 * override the system. In system mode the page follows the OS by listening here.
 */
const apply = (dark: boolean) => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
};

const systemDark = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export function applyAppearance(appearance: Appearance) {
  if (appearance !== 'system') return apply(appearance === 'dark');
  apply(systemDark());
}

/** Follows the pref and, in system mode, the OS. Call applyAppearance before the first paint. */
export function useAppearance(appearance: Appearance) {
  useEffect(() => {
    applyAppearance(appearance);
    if (appearance !== 'system') return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyAppearance('system');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [appearance]);
}
