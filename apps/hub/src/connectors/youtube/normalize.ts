import type { ChatMessage } from '@streamhub/shared';

export type YtAuthor = {
  channelId?: string;
  displayName?: string;
  profileImageUrl?: string;
  isChatOwner?: boolean;
  isChatModerator?: boolean;
  isChatSponsor?: boolean;
};

export type YtMessage = {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    authorChannelId?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
    userBannedDetails?: { bannedUserDetails?: { channelId?: string } };
    /** REST sends micros as a string, gRPC (longs: Number) as a number. */
    superChatDetails?: { amountMicros?: string | number; currency?: string; amountDisplayString?: string; userComment?: string };
    superStickerDetails?: { amountMicros?: string | number; currency?: string; amountDisplayString?: string };
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean };
    memberMilestoneChatDetails?: { memberLevelName?: string; memberMonth?: number; userComment?: string };
    membershipGiftingDetails?: { giftMembershipsCount?: number; giftMembershipsLevelName?: string };
  };
  authorDetails?: YtAuthor;
};

export type YtListResponse = {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items?: YtMessage[];
};

export type YtNormalized =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'deleted'; id: string }
  | { kind: 'cleared'; authorId: string }
  | { kind: 'ended' };

/** Types shown in the chat feed. YouTube gives plain text only (no emote images). */
const CHAT_TYPES = new Set([
  'textMessageEvent',
  'superChatEvent',
  'superStickerEvent',
  'memberMilestoneChatEvent',
  'newSponsorEvent',
  'membershipGiftingEvent',
  'giftMembershipReceivedEvent',
]);

type Role = ChatMessage['author']['roles'][number];

export function normalizeYouTubeItem(
  item: YtMessage,
  channel: string,
  now: () => number = Date.now,
): YtNormalized | null {
  const type = item.snippet?.type;
  if (!item.id || !type) return null;
  if (type === 'chatEndedEvent') return { kind: 'ended' };
  // Best effort: YouTube stopped reporting deletions (2026-06-23); a tombstone may share the deleted id.
  if (type === 'tombstone') return { kind: 'deleted', id: `youtube:${item.id}` };
  if (type === 'userBannedEvent') {
    const authorId = item.snippet?.userBannedDetails?.bannedUserDetails?.channelId;
    return authorId ? { kind: 'cleared', authorId } : null;
  }
  if (!CHAT_TYPES.has(type)) return null;

  const text = item.snippet?.textMessageDetails?.messageText ?? item.snippet?.displayMessage ?? '';
  if (!text) return null;
  const a = item.authorDetails ?? {};
  const roles: Role[] = [];
  if (a.isChatOwner) roles.push('owner');
  if (a.isChatModerator) roles.push('moderator');
  if (a.isChatSponsor) roles.push('member');
  const sentAt = Date.parse(item.snippet?.publishedAt ?? '');

  return {
    kind: 'message',
    message: {
      id: `youtube:${item.id}`,
      platform: 'youtube',
      channel,
      author: {
        id: a.channelId ?? item.snippet?.authorChannelId ?? 'unknown',
        name: a.displayName ?? 'YouTube user',
        avatarUrl: a.profileImageUrl,
        roles,
      },
      text,
      fragments: [{ kind: 'text', text }],
      sentAt: Number.isNaN(sentAt) ? now() : sentAt,
    },
  };
}

/** `TEXT_MESSAGE_EVENT` → `textMessageEvent`. */
export function grpcTypeToRest(type: string): string {
  return type.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** proto-loader (keepCase: false) already yields REST-style camelCase fields; only the enum differs. */
export function fromGrpcResponse(r: YtListResponse): YtListResponse {
  return {
    ...r,
    items: r.items?.map((item) =>
      item.snippet?.type ? { ...item, snippet: { ...item.snippet, type: grpcTypeToRest(item.snippet.type) } } : item,
    ),
  };
}
