import { describe, expect, it } from 'vitest';
import { ChatMessageSchema } from '@streamhub/shared';
import { fromGrpcResponse, grpcTypeToRest, normalizeYouTubeItem, type YtMessage } from './normalize';

const now = () => 99;

// Shaped after the liveChatMessage resource in docs/connectors/youtube.md.
const text: YtMessage = {
  id: 'LCC.abc',
  snippet: {
    type: 'textMessageEvent',
    publishedAt: '2026-10-01T12:00:00.123Z',
    authorChannelId: 'UCviewer',
    displayMessage: 'hello <b>yt</b> 👋',
    textMessageDetails: { messageText: 'hello <b>yt</b> 👋' },
  },
  authorDetails: {
    channelId: 'UCviewer',
    displayName: 'Viewer',
    profileImageUrl: 'https://yt3.ggpht.com/a.jpg',
    isChatOwner: false,
    isChatModerator: true,
    isChatSponsor: true,
  },
};

describe('normalizeYouTubeItem', () => {
  it('maps a text message', () => {
    const r = normalizeYouTubeItem(text, 'My Channel', now);
    expect(r).toEqual({
      kind: 'message',
      message: {
        id: 'youtube:LCC.abc',
        platform: 'youtube',
        channel: 'My Channel',
        author: { id: 'UCviewer', name: 'Viewer', avatarUrl: 'https://yt3.ggpht.com/a.jpg', roles: ['moderator', 'member'] },
        text: 'hello <b>yt</b> 👋',
        fragments: [{ kind: 'text', text: 'hello <b>yt</b> 👋' }],
        sentAt: Date.parse('2026-10-01T12:00:00.123Z'),
      },
    });
    if (r?.kind === 'message') expect(ChatMessageSchema.safeParse(r.message).success).toBe(true);
  });

  it('maps the chat owner and uses displayMessage for paid events', () => {
    const r = normalizeYouTubeItem(
      { id: 'sc1', snippet: { type: 'superChatEvent', publishedAt: '2026-10-01T12:00:00Z', displayMessage: '$5.00 from Fan: "gg"' }, authorDetails: { channelId: 'UCfan', displayName: 'Fan', isChatOwner: true } },
      'c',
      now,
    );
    expect(r).toMatchObject({ kind: 'message', message: { text: '$5.00 from Fan: "gg"', author: { roles: ['owner'] } } });
  });

  it('maps tombstones, bans and chat end', () => {
    expect(normalizeYouTubeItem({ id: 'x1', snippet: { type: 'tombstone' } }, 'c')).toEqual({ kind: 'deleted', id: 'youtube:x1' });
    expect(
      normalizeYouTubeItem({ id: 'b1', snippet: { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { channelId: 'UCbad' } } } }, 'c'),
    ).toEqual({ kind: 'cleared', authorId: 'UCbad' });
    expect(normalizeYouTubeItem({ id: 'e1', snippet: { type: 'chatEndedEvent' } }, 'c')).toEqual({ kind: 'ended' });
  });

  it('ignores unknown types, polls and items without id', () => {
    expect(normalizeYouTubeItem({ id: 'p1', snippet: { type: 'pollEvent', displayMessage: 'poll' } }, 'c')).toBeNull();
    expect(normalizeYouTubeItem({ snippet: { type: 'textMessageEvent', displayMessage: 'x' } }, 'c')).toBeNull();
    expect(normalizeYouTubeItem({ id: 'q', snippet: { type: 'sponsorOnlyModeStartedEvent' } }, 'c')).toBeNull();
  });

  it('falls back to now and placeholders for missing fields', () => {
    const r = normalizeYouTubeItem({ id: 'm', snippet: { type: 'textMessageEvent', displayMessage: 'hi' } }, 'c', now);
    expect(r).toMatchObject({ message: { sentAt: 99, author: { id: 'unknown', name: 'YouTube user', roles: [] } } });
  });
});

describe('gRPC mapping', () => {
  it('converts proto enum names to REST type names', () => {
    expect(grpcTypeToRest('TEXT_MESSAGE_EVENT')).toBe('textMessageEvent');
    expect(grpcTypeToRest('TOMBSTONE')).toBe('tombstone');
    expect(grpcTypeToRest('GIFT_MEMBERSHIP_RECEIVED_EVENT')).toBe('giftMembershipReceivedEvent');
  });

  it('maps a stream response so the REST normalizer can read it', () => {
    const r = fromGrpcResponse({
      nextPageToken: 'tok',
      items: [{ ...text, snippet: { ...text.snippet, type: 'TEXT_MESSAGE_EVENT' } }],
    });
    expect(r.nextPageToken).toBe('tok');
    expect(normalizeYouTubeItem(r.items![0]!, 'c', now)).toMatchObject({ kind: 'message' });
  });
});
