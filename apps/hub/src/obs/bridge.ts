import type { Envelope, EventPayload, KnownEventType, StreamState } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import { backoffDelay } from '../util/backoff';
import { realTimer, type Timer } from '../util/timer';
import { describeError } from '../util/errors';
export type { Timer } from '../util/timer';

/** The subset of obs-websocket-js we use, so tests can fake it. */
export interface ObsClient {
  connect(url: string, password?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  call(requestType: string, requestData?: object): Promise<unknown>;
  on<T>(event: string, listener: (data: T) => void): unknown;
}

export type ObsBridgeOptions = {
  bus: Bus;
  client: ObsClient;
  url: string;
  password: string;
  timer?: Timer;
  rand?: () => number;
  now?: () => number;
};

type ObsScene = { sceneName: string; sceneIndex: number };

const OUTPUT_STATES: Record<string, StreamState> = {
  OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
  OBS_WEBSOCKET_OUTPUT_STARTED: 'live',
  OBS_WEBSOCKET_OUTPUT_RECONNECTING: 'live',
  OBS_WEBSOCKET_OUTPUT_RECONNECTED: 'live',
  OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
  OBS_WEBSOCKET_OUTPUT_STOPPED: 'stopped',
};

export class ObsBridge {
  private connected = false;
  private stopped = true;
  private attempt = 0;
  private retry: unknown = null;
  private streamStartedAt: number | undefined;
  private unsubscribeBus: (() => void) | null = null;
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: ObsBridgeOptions) {
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    const { client } = opts;
    client.on('ConnectionClosed', (err: unknown) => this.onClosed(err));
    client.on('CurrentProgramSceneChanged', (d: { sceneName: string }) =>
      this.emit('obs.scene.changed', { scene: d.sceneName }),
    );
    client.on('SceneListChanged', () => {
      this.refreshScenes().catch((err) => console.warn(`[obs] scene refresh failed: ${describeError(err)}`));
    });
    client.on('StreamStateChanged', (d: { outputState: string }) => this.onStreamState(d.outputState));
  }

  start() {
    this.stopped = false;
    this.unsubscribeBus = this.opts.bus.subscribe(['obs.cmd.'], (e) => void this.handleCommand(e));
    void this.connect();
  }

  async stop() {
    this.stopped = true;
    this.unsubscribeBus?.();
    if (this.retry !== null) this.timer.clear(this.retry);
    this.retry = null;
    await this.opts.client.disconnect().catch(() => {});
  }

  private emit<T extends KnownEventType>(type: T, payload: EventPayload<T>) {
    this.opts.bus.publish({ type, payload, source: 'obs' });
  }

  private async connect() {
    if (this.stopped) return;
    try {
      await this.opts.client.connect(this.opts.url, this.opts.password || undefined);
      this.connected = true;
      this.attempt = 0;
      this.emit('obs.connection', { connected: true });
      await this.refreshScenes();
      await this.refreshStream();
    } catch (err) {
      this.connected = false;
      this.emit('obs.connection', { connected: false, detail: describeError(err) });
      this.scheduleReconnect();
    }
  }

  private onClosed(err: unknown) {
    if (!this.connected) return; // connect() failures are handled in connect()
    this.connected = false;
    this.emit('obs.connection', { connected: false, detail: describeError(err) });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.retry !== null) return;
    const delay = backoffDelay(this.attempt++, this.rand);
    this.retry = this.timer.set(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }

  private async refreshScenes() {
    const list = (await this.opts.client.call('GetSceneList')) as {
      currentProgramSceneName: string;
      scenes: ObsScene[];
    };
    const scenes = [...list.scenes]
      .sort((a, b) => b.sceneIndex - a.sceneIndex)
      .map((s) => s.sceneName);
    this.emit('obs.scenes.list', { scenes, current: list.currentProgramSceneName });
  }

  private async refreshStream() {
    const status = (await this.opts.client.call('GetStreamStatus')) as {
      outputActive: boolean;
      outputDuration: number;
    };
    if (status.outputActive) {
      this.streamStartedAt = this.now() - status.outputDuration;
      this.emit('obs.stream.state', { state: 'live', startedAt: this.streamStartedAt });
    } else {
      this.streamStartedAt = undefined;
      this.emit('obs.stream.state', { state: 'stopped' });
    }
  }

  private onStreamState(outputState: string) {
    const state = OUTPUT_STATES[outputState];
    if (!state) return;
    if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.streamStartedAt = this.now();
    if (state === 'stopped') this.streamStartedAt = undefined;
    this.emit(
      'obs.stream.state',
      state === 'live' ? { state, startedAt: this.streamStartedAt ?? this.now() } : { state },
    );
  }

  private async handleCommand(e: Envelope) {
    if (!this.connected) {
      console.warn(`[obs] ignoring ${e.type}: OBS is not connected`);
      return;
    }
    const { client } = this.opts;
    try {
      switch (e.type) {
        case 'obs.cmd.setScene': {
          const p = e.payload as EventPayload<'obs.cmd.setScene'>;
          await client.call('SetCurrentProgramScene', { sceneName: p.scene });
          break;
        }
        case 'obs.cmd.startStream':
          await client.call('StartStream');
          break;
        case 'obs.cmd.stopStream':
          await client.call('StopStream');
          break;
        case 'obs.cmd.setSourceVisible': {
          const p = e.payload as EventPayload<'obs.cmd.setSourceVisible'>;
          const { sceneItemId } = (await client.call('GetSceneItemId', {
            sceneName: p.scene,
            sourceName: p.source,
          })) as { sceneItemId: number };
          await client.call('SetSceneItemEnabled', {
            sceneName: p.scene,
            sceneItemId,
            sceneItemEnabled: p.visible,
          });
          break;
        }
      }
    } catch (err) {
      console.warn(`[obs] ${e.type} failed: ${describeError(err)}`);
    }
  }
}
