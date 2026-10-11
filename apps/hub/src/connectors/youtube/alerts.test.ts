import { describe, expect, it } from 'vitest';
import { youtubeAlert } from './alerts';
import type { YtMessage } from './normalize';

const item = (snippet: NonNullable<YtMessage['snippet']>): YtMessage => ({
  id: 'i1',
  snippet,
  authorDetails: { channelId: 'UC1', displayName: 'Ada', profileImageUrl: 'https://yt/a.jpg' },
});

describe('youtubeAlert', () => {
  it('turns a Super Sticker into a tip, with gRPC numeric micros', () => {
    expect(
      youtubeAlert(item({ type: 'superStickerEvent', superStickerDetails: { amountMicros: 1_750_000, currency: 'eur', amountDisplayString: '€1.75' } }), 3),
    ).toEqual({
      id: 'youtube:i1',
      kind: 'tip',
      platform: 'youtube',
      user: { id: 'UC1', name: 'Ada', avatarUrl: 'https://yt/a.jpg' },
      amount: 1.75,
      currency: 'EUR',
      amountText: '€1.75',
      at: 3,
    });
  });

  it('maps memberships to subs, milestones to resubs and gift purchases to gift subs', () => {
    expect(youtubeAlert(item({ type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Founders' } }), 1)).toMatchObject({
      kind: 'sub',
      tier: 'Founders',
    });
    expect(
      youtubeAlert(item({ type: 'memberMilestoneChatEvent', memberMilestoneChatDetails: { memberMonth: 6, userComment: 'six!' } }), 1),
    ).toMatchObject({ kind: 'resub', months: 6, message: 'six!' });
    expect(youtubeAlert(item({ type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 10 } }), 1)).toMatchObject({
      kind: 'giftsub',
      count: 10,
    });
  });

  it('skips the gift each member receives, and plain chat', () => {
    expect(youtubeAlert(item({ type: 'giftMembershipReceivedEvent' }), 1)).toBeNull();
    expect(youtubeAlert(item({ type: 'textMessageEvent', displayMessage: 'hi' }), 1)).toBeNull();
  });

  it('drops a currency YouTube sent in an unexpected form', () => {
    const alert = youtubeAlert(item({ type: 'superChatEvent', superChatDetails: { amountMicros: 'x', currency: 'US$' } }), 1);
    expect(alert).toMatchObject({ kind: 'tip', amount: 0 });
    expect(alert?.currency).toBeUndefined();
  });
});
