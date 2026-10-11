import type { Alert } from '@streamhub/shared';

type User = { id?: string | null; name?: string | null };

export type TwitchNotificationEvent = {
  chatter_user_id: string;
  chatter_user_name: string;
  chatter_is_anonymous?: boolean;
  message_id: string;
  message?: { text?: string };
  notice_type: string;
  sub?: { sub_tier?: string; is_prime?: boolean } | null;
  resub?: { cumulative_months?: number; sub_tier?: string; is_prime?: boolean } | null;
  sub_gift?: { sub_tier?: string; community_gift_id?: string | null } | null;
  community_sub_gift?: { total?: number; sub_tier?: string } | null;
  raid?: { user_id: string; user_name: string; viewer_count: number; profile_image_url?: string } | null;
};

export type TwitchFollowEvent = { user_id: string; user_name: string; followed_at?: string };

export type TwitchCheerChat = {
  chatter_user_id: string;
  chatter_user_name: string;
  message_id: string;
  message: { text: string; fragments: Array<{ type: string; text: string }> };
  cheer?: { bits: number } | null;
  /** Set when the message comes from another channel in a shared chat session. */
  source_broadcaster_user_id?: string | null;
};

const ANONYMOUS = { id: 'anonymous', name: 'Anonymous' };

function tier(plan: string | undefined, prime?: boolean): string | undefined {
  if (prime) return 'Prime';
  const n = Number(plan) / 1000;
  return Number.isInteger(n) && n >= 1 ? String(n) : undefined;
}

function user(u: User, anonymous = false): Alert['user'] {
  if (anonymous || !u.id || !u.name) return ANONYMOUS;
  return { id: u.id, name: u.name };
}

const text = (t: string | undefined) => (t?.trim() ? t.trim().slice(0, 1000) : undefined);

/**
 * `channel.chat.notification` → an alert, for the notices that are alerts. Shared-chat notices
 * (from the other channels in a shared session) are not ours. Each sub in a community gift also
 * arrives as its own `sub_gift`; only the community notice becomes an alert.
 */
export function twitchNotificationAlert(e: TwitchNotificationEvent, at: number): Alert | null {
  const base = { id: `twitch:${e.message_id}`, platform: 'twitch' as const, at };
  const chatter = user({ id: e.chatter_user_id, name: e.chatter_user_name }, e.chatter_is_anonymous);
  switch (e.notice_type) {
    case 'sub':
      return { ...base, kind: 'sub', user: chatter, tier: tier(e.sub?.sub_tier, e.sub?.is_prime), message: text(e.message?.text) };
    case 'resub':
      return {
        ...base,
        kind: 'resub',
        user: chatter,
        months: e.resub?.cumulative_months && e.resub.cumulative_months > 0 ? e.resub.cumulative_months : undefined,
        tier: tier(e.resub?.sub_tier, e.resub?.is_prime),
        message: text(e.message?.text),
      };
    case 'sub_gift':
      if (e.sub_gift?.community_gift_id) return null;
      return { ...base, kind: 'giftsub', user: chatter, count: 1, tier: tier(e.sub_gift?.sub_tier) };
    case 'community_sub_gift':
      return {
        ...base,
        kind: 'giftsub',
        user: chatter,
        count: Math.max(1, e.community_sub_gift?.total ?? 1),
        tier: tier(e.community_sub_gift?.sub_tier),
      };
    case 'raid':
      if (!e.raid) return null;
      return {
        ...base,
        kind: 'raid',
        user: { id: e.raid.user_id, name: e.raid.user_name, avatarUrl: e.raid.profile_image_url || undefined },
        count: e.raid.viewer_count,
      };
    default:
      return null;
  }
}

/** `channel.follow` carries no event id, so the EventSub message id identifies it. */
export function twitchFollowAlert(e: TwitchFollowEvent, messageId: string, at: number): Alert {
  const followedAt = e.followed_at ? Date.parse(e.followed_at) : NaN;
  return {
    id: `twitch:${messageId}`,
    kind: 'follow',
    platform: 'twitch',
    user: user({ id: e.user_id, name: e.user_name }),
    at: Number.isNaN(followedAt) ? at : followedAt,
  };
}

/** A chat message with Bits in it. Cheers sent in another channel of a shared chat are not ours. */
export function twitchCheerAlert(e: TwitchCheerChat, at: number): Alert | null {
  if (!e.cheer || e.cheer.bits <= 0 || e.source_broadcaster_user_id) return null;
  const message = e.message.fragments
    .filter((f) => f.type !== 'cheermote')
    .map((f) => f.text)
    .join('')
    .replace(/\s+/g, ' ');
  return {
    id: `twitch:cheer:${e.message_id}`,
    kind: 'cheer',
    platform: 'twitch',
    user: user({ id: e.chatter_user_id, name: e.chatter_user_name }),
    amount: e.cheer.bits,
    message: text(message),
    at,
  };
}
