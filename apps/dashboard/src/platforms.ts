import type { Platform } from '@streamhub/shared';

export const PLATFORMS: Record<Platform, { label: string; color: string }> = {
  twitch: { label: 'Twitch', color: '#9146ff' },
  youtube: { label: 'YouTube', color: '#ff0033' },
  kick: { label: 'Kick', color: '#53fc18' },
};
