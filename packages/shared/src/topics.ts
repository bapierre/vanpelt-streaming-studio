/** `'*'` matches everything, `'obs.'` is a prefix, `'chat.message'` is an exact type. */
export function topicMatches(topics: Iterable<string>, type: string): boolean {
  for (const topic of topics) {
    if (topic === '*') return true;
    if (topic.endsWith('.') ? type.startsWith(topic) : type === topic) return true;
  }
  return false;
}
