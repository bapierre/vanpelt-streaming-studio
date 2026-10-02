import { describe, expect, it } from 'vitest';
import { ChatMessageSchema } from '@streamhub/shared';
import chatMessage from './fixtures/chat-message.json';
import chatEmotes from './fixtures/chat-emotes.json';
import messageDelete from './fixtures/message-delete.json';
import {
  normalizeTwitchClear,
  normalizeTwitchDelete,
  normalizeTwitchMessage,
  twitchEmoteUrl,
  type TwitchChatEvent,
} from './normalize';

const now = () => 123;

describe('normalizeTwitchMessage', () => {
  it('maps the documented regular chat message', () => {
    const msg = normalizeTwitchMessage(chatMessage.payload.event as TwitchChatEvent, chatMessage.metadata.message_timestamp, now);
    expect(msg).toEqual({
      id: 'twitch:cc106a89-1814-919d-454c-f4f2f970aae7',
      platform: 'twitch',
      channel: 'streamer',
      author: { id: '4145994', name: 'viewer32', color: '#00FF7F', roles: ['moderator', 'subscriber'] },
      text: 'Hi chat',
      fragments: [{ kind: 'text', text: 'Hi chat' }],
      sentAt: Date.parse('2023-11-06T18:11:47.492Z'),
    });
    expect(ChatMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('maps emotes to CDN urls, preferring animated, and the broadcaster to owner', () => {
    const msg = normalizeTwitchMessage(chatEmotes.payload.event as TwitchChatEvent, chatEmotes.metadata.message_timestamp, now);
    expect(msg.author).toEqual({ id: '1971641', name: 'streamer', color: undefined, roles: ['owner'] });
    expect(msg.fragments).toEqual([
      { kind: 'text', text: 'RAID ' },
      { kind: 'emote', name: 'TombRaid', url: 'https://static-cdn.jtvnw.net/emoticons/v2/864205/static/dark/2.0' },
      { kind: 'text', text: ' RAID ' },
      { kind: 'emote', name: 'twitchRaid', url: 'https://static-cdn.jtvnw.net/emoticons/v2/62836/animated/dark/2.0' },
      { kind: 'text', text: ' RAID' },
    ]);
  });

  it('maps mentions, cheermotes and gifs', () => {
    const event = {
      ...(chatMessage.payload.event as TwitchChatEvent),
      message: {
        text: '@viewer32 cheer100 gif',
        fragments: [
          { type: 'mention', text: '@viewer32', mention: { user_name: 'viewer32' } },
          { type: 'text', text: ' ' },
          { type: 'cheermote', text: 'cheer100' },
          { type: 'gif', text: 'gif', gif: { url: 'https://media.example/g.gif' } },
        ],
      },
    };
    expect(normalizeTwitchMessage(event, '2023-11-06T18:11:47Z', now).fragments).toEqual([
      { kind: 'mention', name: 'viewer32' },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'cheer100' },
      { kind: 'emote', name: 'gif', url: 'https://media.example/g.gif' },
    ]);
  });

  it('maps vip, founder and lead_moderator badges', () => {
    const event = { ...(chatMessage.payload.event as TwitchChatEvent), badges: [{ set_id: 'vip' }, { set_id: 'founder' }, { set_id: 'lead_moderator' }] };
    expect(normalizeTwitchMessage(event, '2023-11-06T18:11:47Z', now).author.roles).toEqual(['vip', 'subscriber', 'moderator']);
  });

  it('falls back to now for an unparseable timestamp', () => {
    expect(normalizeTwitchMessage(chatMessage.payload.event as TwitchChatEvent, 'garbage', now).sentAt).toBe(123);
  });
});

describe('deletes and clears', () => {
  it('maps a deleted message to its normalized id', () => {
    expect(normalizeTwitchDelete(messageDelete.payload.event)).toEqual({ id: 'twitch:ab24e0b0-2260-4bac-94e4-05eedd4ecd0e' });
  });
  it('maps a full clear and a per-user clear', () => {
    expect(normalizeTwitchClear({})).toEqual({ platform: 'twitch' });
    expect(normalizeTwitchClear({ target_user_id: '7734' })).toEqual({ platform: 'twitch', authorId: '7734' });
  });
});

describe('twitchEmoteUrl', () => {
  it('defaults to static', () => {
    expect(twitchEmoteUrl('1')).toBe('https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/2.0');
  });
});
