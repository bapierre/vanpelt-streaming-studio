import type {
  ChatMessage,
  ConnectionState,
  ConnectorStatus,
  Envelope,
  EventPayload,
  Platform,
  PlatformLive,
  StreamState,
} from '@streamhub/shared';

export const CHAT_LIMIT = 300;

export type DashboardState = {
  hubConnected: boolean;
  obs: { connected: boolean; detail?: string };
  scenes: string[];
  currentScene: string | null;
  stream: { state: StreamState; startedAt?: number };
  platforms: Partial<Record<Platform, { status: ConnectorStatus; detail?: string }>>;
  live: Partial<Record<Platform, PlatformLive>>;
  chat: ChatMessage[];
  featuredId: string | null;
  connections: Partial<Record<Platform, ConnectionState>>;
  obsSettings: EventPayload<'obs.settings'> | null;
  sources: EventPayload<'obs.sources.list'> | null;
  destinations: EventPayload<'destinations.list'>;
};

export type Action =
  | { kind: 'hub'; connected: boolean }
  | { kind: 'event'; event: Envelope }
  | { kind: 'backfill'; events: Envelope[] }
  | { kind: 'chatBatch'; events: Envelope[] };

export const initialState: DashboardState = {
  hubConnected: false,
  obs: { connected: false },
  scenes: [],
  currentScene: null,
  stream: { state: 'stopped' },
  platforms: {},
  live: {},
  chat: [],
  featuredId: null,
  connections: {},
  obsSettings: null,
  sources: null,
  destinations: { destinations: [], inObs: null },
};

export function reduce(state: DashboardState, action: Action): DashboardState {
  if (action.kind === 'hub') {
    // On reconnect the hub resends retained state, so start clean.
    return action.connected ? { ...state, hubConnected: true } : initialState;
  }
  if (action.kind === 'backfill') {
    const known = new Set(state.chat.map((m) => m.id));
    const older = action.events
      .filter((e) => e.type === 'chat.message')
      .map((e) => e.payload as ChatMessage)
      .filter((m) => !known.has(m.id));
    const chat = [...older, ...state.chat].sort((a, b) => a.sentAt - b.sentAt).slice(-CHAT_LIMIT);
    return { ...state, chat };
  }
  if (action.kind === 'chatBatch') {
    const known = new Set(state.chat.map((m) => m.id));
    const fresh: ChatMessage[] = [];
    for (const e of action.events) {
      const m = e.payload as ChatMessage;
      if (known.has(m.id)) continue;
      known.add(m.id);
      fresh.push(m);
    }
    if (fresh.length === 0) return state;
    return { ...state, chat: [...state.chat, ...fresh].slice(-CHAT_LIMIT) };
  }
  const { type, payload } = action.event;
  switch (type) {
    case 'obs.connection':
      return { ...state, obs: payload as EventPayload<'obs.connection'> };
    case 'obs.scenes.list': {
      const p = payload as EventPayload<'obs.scenes.list'>;
      return { ...state, scenes: p.scenes, currentScene: p.current };
    }
    case 'obs.scene.changed':
      return { ...state, currentScene: (payload as EventPayload<'obs.scene.changed'>).scene };
    case 'obs.stream.state':
      return { ...state, stream: payload as EventPayload<'obs.stream.state'> };
    case 'obs.settings':
      return { ...state, obsSettings: payload as EventPayload<'obs.settings'> };
    case 'obs.sources.list':
      return { ...state, sources: payload as EventPayload<'obs.sources.list'> };
    case 'destinations.list':
      return { ...state, destinations: payload as EventPayload<'destinations.list'> };
    case 'platform.status': {
      const p = payload as EventPayload<'platform.status'>;
      return {
        ...state,
        platforms: { ...state.platforms, [p.platform]: { status: p.status, detail: p.detail } },
      };
    }
    case 'platform.live': {
      const p = payload as PlatformLive;
      return { ...state, live: { ...state.live, [p.platform]: p } };
    }
    case 'chat.message': {
      const m = payload as ChatMessage;
      if (state.chat.some((c) => c.id === m.id)) return state;
      return { ...state, chat: [...state.chat, m].slice(-CHAT_LIMIT) };
    }
    case 'chat.deleted': {
      const { id } = payload as EventPayload<'chat.deleted'>;
      return { ...state, chat: state.chat.filter((m) => m.id !== id) };
    }
    case 'chat.cleared': {
      const p = payload as EventPayload<'chat.cleared'>;
      return {
        ...state,
        chat: state.chat.filter((m) => m.platform !== p.platform || (p.authorId !== undefined && m.author.id !== p.authorId)),
      };
    }
    case 'show.feature.set':
      return { ...state, featuredId: (payload as EventPayload<'show.feature.set'>).message.id };
    case 'show.feature.clear':
      return { ...state, featuredId: null };
    case 'connections.state': {
      const p = payload as ConnectionState;
      return { ...state, connections: { ...state.connections, [p.platform]: p } };
    }
    default:
      return state;
  }
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
