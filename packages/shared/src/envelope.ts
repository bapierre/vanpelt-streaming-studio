export type Envelope<T extends string = string, P = unknown> = {
  id: string; // ulid, sortable
  type: T; // 'domain.action'
  ts: number; // epoch ms, set by hub
  source: string; // 'hub' | 'obs' | 'connector:<platform>' | 'dashboard' | 'module:<id>'
  payload: P;
};
