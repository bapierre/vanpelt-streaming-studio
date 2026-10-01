import type { ChatMessage } from './events';

export function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'twitch:1',
    platform: 'twitch',
    channel: 'yatf',
    author: { id: 'u1', name: 'viewer', roles: [] },
    text: 'hello',
    fragments: [{ kind: 'text', text: 'hello' }],
    sentAt: 1_700_000_000_000,
    ...overrides,
  };
}
