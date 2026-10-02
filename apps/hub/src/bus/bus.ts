import { monotonicFactory } from 'ulid';
import { topicMatches, validatePayload, type ChatMessage, type Envelope } from '@streamhub/shared';

export type PublishInput = { type: string; payload: unknown; source: string };
export type PublishResult = { ok: true; event: Envelope } | { ok: false; error: string };
type Handler = (e: Envelope) => void;

const HISTORY_LIMITS: Record<string, number> = { 'chat.message': 200 };

const RETAINED_TYPES = new Set([
  'obs.connection',
  'obs.scenes.list',
  'obs.scene.changed',
  'obs.stream.state',
  'relay.connection',
]);

const PER_PLATFORM_RETAINED = new Set(['platform.status', 'connections.state']);

function retainKey(e: Envelope): string | null {
  if (RETAINED_TYPES.has(e.type)) return e.type;
  if (PER_PLATFORM_RETAINED.has(e.type)) {
    return `${e.type}:${(e.payload as { platform: string }).platform}`;
  }
  return null;
}

export class Bus {
  private readonly subs = new Set<{ topics: string[]; handler: Handler }>();
  private readonly retained = new Map<string, Envelope>();
  private readonly histories = new Map<string, Envelope[]>();
  private readonly nextId = monotonicFactory();

  constructor(private readonly now: () => number = Date.now) {}

  publish(input: PublishInput): PublishResult {
    const valid = validatePayload(input.type, input.payload);
    if (!valid.ok) return valid;
    const ts = this.now();
    const event: Envelope = {
      id: this.nextId(ts),
      type: input.type,
      ts,
      source: input.source,
      payload: valid.payload,
    };

    const key = retainKey(event);
    if (key) this.retained.set(key, event);

    const limit = HISTORY_LIMITS[event.type];
    if (limit) {
      const list = this.histories.get(event.type) ?? [];
      list.push(event);
      if (list.length > limit) list.shift();
      this.histories.set(event.type, list);
    }
    this.applyModeration(event);

    for (const sub of [...this.subs]) {
      if (!topicMatches(sub.topics, event.type)) continue;
      try {
        sub.handler(event);
      } catch (err) {
        console.error(`[bus] handler for ${event.type} threw`, err);
      }
    }
    return { ok: true, event };
  }

  /** Keep chat history consistent with deletions and clears, so a reload does not bring removed messages back. */
  private applyModeration(event: Envelope): void {
    let drop: ((m: ChatMessage) => boolean) | null = null;
    if (event.type === 'chat.deleted') {
      const { id } = event.payload as { id: string };
      drop = (m) => m.id === id;
    } else if (event.type === 'chat.cleared') {
      const { platform, authorId } = event.payload as { platform: string; authorId?: string };
      drop = (m) => m.platform === platform && (authorId === undefined || m.author.id === authorId);
    }
    const list = this.histories.get('chat.message');
    if (!drop || !list) return;
    const remove = drop;
    this.histories.set(
      'chat.message',
      list.filter((e) => !remove(e.payload as ChatMessage)),
    );
  }

  subscribe(topics: string[], handler: Handler): () => void {
    const sub = { topics, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  /** Latest state events matching `topics`, oldest first. */
  retainedFor(topics: string[]): Envelope[] {
    return [...this.retained.values()]
      .filter((e) => topicMatches(topics, e.type))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  history(type: string, limit: number): Envelope[] {
    return (this.histories.get(type) ?? []).slice(-limit);
  }
}
