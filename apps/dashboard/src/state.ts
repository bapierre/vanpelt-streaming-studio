import type {
  ConnectorStatus,
  Envelope,
  EventPayload,
  Platform,
  StreamState,
} from '@streamhub/shared';

export type DashboardState = {
  hubConnected: boolean;
  obs: { connected: boolean; detail?: string };
  scenes: string[];
  currentScene: string | null;
  stream: { state: StreamState; startedAt?: number };
  platforms: Partial<Record<Platform, { status: ConnectorStatus; detail?: string }>>;
};

export type Action = { kind: 'hub'; connected: boolean } | { kind: 'event'; event: Envelope };

export const initialState: DashboardState = {
  hubConnected: false,
  obs: { connected: false },
  scenes: [],
  currentScene: null,
  stream: { state: 'stopped' },
  platforms: {},
};

export function reduce(state: DashboardState, action: Action): DashboardState {
  if (action.kind === 'hub') {
    // On reconnect the hub resends retained state, so start clean.
    return action.connected ? { ...state, hubConnected: true } : initialState;
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
    case 'platform.status': {
      const p = payload as EventPayload<'platform.status'>;
      return {
        ...state,
        platforms: { ...state.platforms, [p.platform]: { status: p.status, detail: p.detail } },
      };
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
