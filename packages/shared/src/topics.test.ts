import { describe, expect, it } from 'vitest';
import { topicMatches } from './topics';

describe('topicMatches', () => {
  it('treats a trailing dot as a prefix', () => {
    expect(topicMatches(['obs.'], 'obs.scene.changed')).toBe(true);
    expect(topicMatches(['obs.'], 'chat.message')).toBe(false);
  });
  it('treats a topic without trailing dot as an exact type', () => {
    expect(topicMatches(['chat.message'], 'chat.message')).toBe(true);
    expect(topicMatches(['chat'], 'chat.message')).toBe(false);
  });
  it('matches everything with *', () => {
    expect(topicMatches(['*'], 'anything.at.all')).toBe(true);
  });
  it('is false for no topics', () => {
    expect(topicMatches([], 'chat.message')).toBe(false);
  });
});
