import type { ChatMessage } from '@streamhub/shared';

export type TwitchFragment = {
  type: string;
  text: string;
  emote?: { id: string; format?: string[] } | null;
  mention?: { user_name: string } | null;
  gif?: { url?: string } | null;
};

export type TwitchChatEvent = {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  chatter_user_id: string;
  chatter_user_name: string;
  message_id: string;
  message: { text: string; fragments: TwitchFragment[] };
  color: string;
  badges: Array<{ set_id: string }>;
};

type Role = ChatMessage['author']['roles'][number];

const BADGE_ROLES: Record<string, Role> = {
  broadcaster: 'owner',
  moderator: 'moderator',
  lead_moderator: 'moderator',
  vip: 'vip',
  subscriber: 'subscriber',
  founder: 'subscriber',
};

export function twitchEmoteUrl(id: string, formats: string[] = ['static']): string {
  const format = formats.includes('animated') ? 'animated' : 'static';
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/${format}/dark/2.0`;
}

/** RFC3339 with nanoseconds → epoch ms. */
function parseTimestamp(ts: string, now: () => number): number {
  const ms = Date.parse(ts.replace(/(\.\d{3})\d*Z$/, '$1Z'));
  return Number.isNaN(ms) ? now() : ms;
}

function fragment(f: TwitchFragment): ChatMessage['fragments'][number] {
  if (f.type === 'emote' && f.emote) return { kind: 'emote', name: f.text, url: twitchEmoteUrl(f.emote.id, f.emote.format) };
  if (f.type === 'mention' && f.mention) return { kind: 'mention', name: f.mention.user_name };
  if (f.type === 'gif' && f.gif?.url) return { kind: 'emote', name: f.text, url: f.gif.url };
  return { kind: 'text', text: f.text };
}

export function normalizeTwitchMessage(
  event: TwitchChatEvent,
  messageTimestamp: string,
  now: () => number = Date.now,
): ChatMessage {
  const roles: Role[] = [];
  const add = (role: Role | undefined) => {
    if (role && !roles.includes(role)) roles.push(role);
  };
  if (event.chatter_user_id === event.broadcaster_user_id) add('owner');
  for (const badge of event.badges ?? []) add(BADGE_ROLES[badge.set_id]);

  return {
    id: `twitch:${event.message_id}`,
    platform: 'twitch',
    channel: event.broadcaster_user_login,
    author: {
      id: event.chatter_user_id,
      name: event.chatter_user_name,
      color: event.color || undefined,
      roles,
    },
    text: event.message.text,
    fragments: event.message.fragments.map(fragment),
    sentAt: parseTimestamp(messageTimestamp, now),
  };
}

export function normalizeTwitchDelete(event: { message_id: string }): { id: string } {
  return { id: `twitch:${event.message_id}` };
}

export function normalizeTwitchClear(event: { target_user_id?: string }): { platform: 'twitch'; authorId?: string } {
  return event.target_user_id ? { platform: 'twitch', authorId: event.target_user_id } : { platform: 'twitch' };
}
