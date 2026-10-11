import { describe, expect, it } from 'vitest';
import { twitchCheerAlert, twitchFollowAlert, twitchNotificationAlert, type TwitchNotificationEvent } from './alerts';

const notice = (over: Partial<TwitchNotificationEvent>): TwitchNotificationEvent => ({
  chatter_user_id: '49912639',
  chatter_user_name: 'viewer23',
  chatter_is_anonymous: false,
  message_id: 'd62235c8',
  message: { text: '' },
  notice_type: 'sub',
  ...over,
});

describe('twitchNotificationAlert', () => {
  it('maps a resub with its months, tier and message (Twitch docs example)', () => {
    const alert = twitchNotificationAlert(
      notice({
        notice_type: 'resub',
        message: { text: ' love the show ' },
        resub: { cumulative_months: 10, sub_tier: '1000', is_prime: false },
      }),
      5,
    );
    expect(alert).toEqual({
      id: 'twitch:d62235c8',
      kind: 'resub',
      platform: 'twitch',
      user: { id: '49912639', name: 'viewer23' },
      months: 10,
      tier: '1',
      message: 'love the show',
      at: 5,
    });
  });

  it('marks Prime subs and tier 3 subs', () => {
    expect(twitchNotificationAlert(notice({ sub: { sub_tier: '1000', is_prime: true } }), 1)?.tier).toBe('Prime');
    expect(twitchNotificationAlert(notice({ sub: { sub_tier: '3000' } }), 1)?.tier).toBe('3');
  });

  it('shows one alert for a community gift, not one per gifted sub', () => {
    expect(
      twitchNotificationAlert(notice({ notice_type: 'community_sub_gift', community_sub_gift: { total: 5, sub_tier: '1000' } }), 1),
    ).toMatchObject({ kind: 'giftsub', count: 5 });
    expect(
      twitchNotificationAlert(notice({ notice_type: 'sub_gift', sub_gift: { sub_tier: '1000', community_gift_id: 'g1' } }), 1),
    ).toBeNull();
    expect(
      twitchNotificationAlert(notice({ notice_type: 'sub_gift', sub_gift: { sub_tier: '1000', community_gift_id: null } }), 1),
    ).toMatchObject({ kind: 'giftsub', count: 1 });
  });

  it('hides an anonymous gifter', () => {
    const alert = twitchNotificationAlert(
      notice({ notice_type: 'community_sub_gift', chatter_is_anonymous: true, community_sub_gift: { total: 2 } }),
      1,
    );
    expect(alert?.user).toEqual({ id: 'anonymous', name: 'Anonymous' });
  });

  it('credits a raid to the raiding channel', () => {
    const alert = twitchNotificationAlert(
      notice({ notice_type: 'raid', raid: { user_id: '5', user_name: 'Friend', viewer_count: 42, profile_image_url: 'https://x/y.png' } }),
      1,
    );
    expect(alert).toMatchObject({ kind: 'raid', count: 42, user: { id: '5', name: 'Friend', avatarUrl: 'https://x/y.png' } });
  });

  it('ignores notices that are not alerts, including shared chat', () => {
    expect(twitchNotificationAlert(notice({ notice_type: 'announcement' }), 1)).toBeNull();
    expect(twitchNotificationAlert(notice({ notice_type: 'shared_chat_sub' }), 1)).toBeNull();
  });
});

describe('twitchFollowAlert', () => {
  it('uses the follow time and the EventSub message id', () => {
    expect(twitchFollowAlert({ user_id: '1', user_name: 'Ada', followed_at: '2023-07-15T18:16:11.17106713Z' }, 'msg', 9)).toEqual({
      id: 'twitch:msg',
      kind: 'follow',
      platform: 'twitch',
      user: { id: '1', name: 'Ada' },
      at: Date.parse('2023-07-15T18:16:11.171Z'),
    });
  });
});

describe('twitchCheerAlert', () => {
  const chat = {
    chatter_user_id: '1',
    chatter_user_name: 'Ada',
    message_id: 'm',
    message: { text: 'Cheer50 go team', fragments: [{ type: 'cheermote', text: 'Cheer50' }, { type: 'text', text: ' go team' }] },
  };
  it('turns Bits into a cheer and drops the cheermotes from the message', () => {
    expect(twitchCheerAlert({ ...chat, cheer: { bits: 50 } }, 1)).toMatchObject({ kind: 'cheer', amount: 50, message: 'go team' });
  });
  it('ignores plain messages and cheers from another channel in shared chat', () => {
    expect(twitchCheerAlert({ ...chat, cheer: null }, 1)).toBeNull();
    expect(twitchCheerAlert({ ...chat, cheer: { bits: 50 }, source_broadcaster_user_id: '99' }, 1)).toBeNull();
  });
});
