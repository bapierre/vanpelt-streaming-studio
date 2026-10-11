import type { CSSProperties } from 'react';
import type { Platform } from '@streamhub/shared';

export const PLATFORMS: Record<Platform, { label: string; color: string }> = {
  twitch: { label: 'Twitch', color: '#9146ff' },
  youtube: { label: 'YouTube', color: '#ff0033' },
  kick: { label: 'Kick', color: '#53fc18' },
  x: { label: 'X', color: '#0f1419' },
};

/** Platforms with a chat connector; X only reports livestream state. */
export const CHAT_PLATFORMS: Platform[] = ['twitch', 'youtube', 'kick'];

/** Exposes the brand colour to CSS as `--platform`; styles.css decides how to tint with it. */
export const platformColor = (p: Platform) => ({ '--platform': PLATFORMS[p].color }) as CSSProperties;
