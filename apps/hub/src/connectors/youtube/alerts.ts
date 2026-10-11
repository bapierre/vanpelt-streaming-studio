import type { Alert } from '@streamhub/shared';
import type { YtMessage } from './normalize';

const text = (t: string | undefined) => (t?.trim() ? t.trim().slice(0, 1000) : undefined);
const level = (t: string | undefined) => (t?.trim() ? t.trim().slice(0, 100) : undefined);

function money(d: { amountMicros?: string | number; currency?: string; amountDisplayString?: string }) {
  const micros = Number(d.amountMicros);
  const currency = d.currency?.toUpperCase();
  return {
    amount: Number.isFinite(micros) && micros >= 0 ? micros / 1_000_000 : 0,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
    amountText: d.amountDisplayString?.slice(0, 40) || undefined,
  };
}

/**
 * Live chat events that are alerts: Super Chats and Super Stickers are tips, a new member is a sub,
 * a milestone is a resub and a gift purchase is a gift. Each gifted member's own "received" event
 * is skipped so a gift shows once.
 */
export function youtubeAlert(item: YtMessage, at: number): Alert | null {
  const s = item.snippet;
  if (!item.id || !s?.type) return null;
  const a = item.authorDetails ?? {};
  const base = {
    id: `youtube:${item.id}`,
    platform: 'youtube' as const,
    user: {
      id: a.channelId ?? s.authorChannelId ?? 'unknown',
      name: a.displayName ?? 'YouTube user',
      ...(a.profileImageUrl ? { avatarUrl: a.profileImageUrl } : {}),
    },
    at,
  };
  switch (s.type) {
    case 'superChatEvent':
      return { ...base, kind: 'tip', ...money(s.superChatDetails ?? {}), message: text(s.superChatDetails?.userComment) };
    case 'superStickerEvent':
      return { ...base, kind: 'tip', ...money(s.superStickerDetails ?? {}) };
    case 'newSponsorEvent':
      return { ...base, kind: 'sub', tier: level(s.newSponsorDetails?.memberLevelName) };
    case 'memberMilestoneChatEvent': {
      const months = s.memberMilestoneChatDetails?.memberMonth;
      return {
        ...base,
        kind: 'resub',
        months: months && months > 0 ? months : undefined,
        tier: level(s.memberMilestoneChatDetails?.memberLevelName),
        message: text(s.memberMilestoneChatDetails?.userComment),
      };
    }
    case 'membershipGiftingEvent':
      return {
        ...base,
        kind: 'giftsub',
        count: Math.max(1, s.membershipGiftingDetails?.giftMembershipsCount ?? 1),
        tier: level(s.membershipGiftingDetails?.giftMembershipsLevelName),
      };
    default:
      return null;
  }
}
