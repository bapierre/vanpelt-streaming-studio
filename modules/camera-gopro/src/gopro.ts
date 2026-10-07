import type {
  CameraControl,
  CameraDevice,
  ControlValue,
  DeviceReport,
  DriverCamera,
} from '@streamhub/camera-sdk';

/** Open GoPro HTTP API: https://gopro.github.io/OpenGoPro/http (see docs/cameras/gopro.md). */
export type HttpResult = { status: number; body: unknown };
/** Performs a GET against the camera; rejects only on network failure or timeout. */
export type GoProHttp = (path: string) => Promise<HttpResult>;
export type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** `host` may carry its own port; otherwise the Open GoPro port 8080 is used. */
export function fetchHttp(host: string, timeoutMs = 3000): GoProHttp {
  const base = `http://${host.includes(':') ? host : `${host}:8080`}`;
  return async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
}

/** USB address is 172.2X.1YZ.51 where XYZ are the serial number's last three digits. */
export function usbHost(serial: string): string | null {
  const xyz = serial.trim().slice(-3);
  if (!/^\d{3}$/.test(xyz)) return null;
  return `172.2${xyz[0]}.1${xyz.slice(1)}.51`;
}

const SETTING_ANTI_FLICKER = 134;
const SETTING_HYPERSMOOTH = 135;
const STATUS_SYSTEM_HOT = 6;
const STATUS_BATTERY_PERCENT = 70;

const WEBCAM_OFF = 0;
const WEBCAM_ERRORS: Record<number, string> = {
  1: 'could not set preset',
  2: 'could not set window size',
  3: 'could not start the stream',
  4: 'shutter error',
  5: 'camera timed out',
  6: 'invalid parameter',
  7: 'webcam unavailable',
  8: 'exited',
};

type Option = { value: string; label: string };
const RESOLUTIONS: Option[] = [
  { value: '12', label: '1080p' },
  { value: '7', label: '720p' },
];
const LENSES: Option[] = [
  { value: '0', label: 'Wide' },
  { value: '2', label: 'Narrow' },
  { value: '3', label: 'SuperView' },
  { value: '4', label: 'Linear' },
];
// Defaults for HERO12; replaced by what the camera reports when it rejects an option.
const HYPERSMOOTH: Option[] = [
  { value: '0', label: 'Off' },
  { value: '1', label: 'Low' },
  { value: '4', label: 'Auto Boost' },
];
const FLICKER_HZ: Option[] = [
  { value: '2', label: '60 Hz' },
  { value: '3', label: '50 Hz' },
];
const FLICKER_TV: Option[] = [
  { value: '0', label: 'NTSC (60 Hz)' },
  { value: '1', label: 'PAL (50 Hz)' },
];

export type GoProConfig = { host: string | null; port: number; resolution: string; lens: string };

export function parseConfig(config: Record<string, unknown>): GoProConfig {
  const str = (k: string) => (typeof config[k] === 'string' ? (config[k] as string).trim() : undefined);
  const host = str('host') || (str('serial') ? usbHost(str('serial')!) : null);
  const port = typeof config.port === 'number' && Number.isInteger(config.port) ? config.port : 8554;
  const resolution = RESOLUTIONS.find((o) => o.label === str('resolution'))?.value ?? '12';
  const lens = LENSES.find((o) => o.label.toLowerCase() === str('lens')?.toLowerCase())?.value ?? '0';
  return { host, port: port >= 1024 && port <= 65535 ? port : 8554, resolution, lens };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    path: string,
  ) {
    super(`camera answered ${status} to ${path.split('?')[0]}`);
  }
}

/** A 403 to a setting change lists the options the camera accepts right now. */
function optionsFrom(body: unknown): Option[] | null {
  const candidates = Array.isArray(body) ? [body] : Object.values((body as object | null) ?? {});
  for (const list of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const opts = list.flatMap((o: unknown) => {
      const { id, display_name } = (o ?? {}) as { id?: unknown; display_name?: unknown };
      return typeof id === 'number' && typeof display_name === 'string' ? [{ value: String(id), label: display_name }] : [];
    });
    if (opts.length === list.length) return opts;
  }
  return null;
}

type Phase = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'misconfigured';

export type GoProOptions = {
  http?: GoProHttp;
  timer?: Timer;
  rand?: () => number;
  keepAliveMs?: number;
  pollMs?: number;
};

export class GoProDevice implements CameraDevice {
  private readonly cfg: GoProConfig;
  private readonly http: GoProHttp | null;
  private readonly timer: Timer;
  private readonly rand: () => number;
  private readonly keepAliveMs: number;
  private readonly pollMs: number;

  private phase: Phase = 'starting';
  private detail: string | undefined;
  private stopped = false;
  private attempt = 0;
  private failures = 0;
  private timers: unknown[] = [];
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private busy: string | undefined;

  private resolution: string;
  private lens: string;
  private webcam = WEBCAM_OFF;
  private webcamError: string | undefined;
  private settings: Record<number, string> = {};
  private zoom = 0;
  private battery: number | undefined;
  private hot: boolean | undefined;
  private readonly accepted = new Map<number, Option[]>();

  constructor(
    private readonly camera: DriverCamera,
    private readonly report: (r: DeviceReport) => void,
    opts: GoProOptions = {},
  ) {
    this.cfg = parseConfig(camera.config);
    this.resolution = this.cfg.resolution;
    this.lens = this.cfg.lens;
    this.http = opts.http ?? (this.cfg.host ? fetchHttp(this.cfg.host) : null);
    this.timer = opts.timer ?? realTimer;
    this.rand = opts.rand ?? Math.random;
    this.keepAliveMs = opts.keepAliveMs ?? 3000; // Open GoPro's recommended keep-alive interval
    this.pollMs = opts.pollMs ?? 5000;
  }

  start(): void {
    if (!this.cfg.host || !this.http) {
      this.phase = 'misconfigured';
      this.detail = 'Set "serial" (or "host") in this camera\'s driverConfig in cameras.json';
      this.emit();
      return;
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    // The webcam keeps streaming on purpose: a hub restart must not black out the show.
    this.stopped = true;
    this.clearTimers();
  }

  set(key: string, value: ControlValue): Promise<void> {
    const run = this.queue.then(async () => {
      this.busy = key;
      this.emit();
      try {
        await this.apply(key, value);
        if (this.phase === 'connected') this.detail = undefined;
      } catch (err) {
        if (this.phase === 'connected') {
          // The camera answered or the value was bad: say so. No answer at all: the camera is gone.
          if (err instanceof HttpError || err instanceof RangeError) this.detail = `${key}: ${err.message}`;
          else this.lost(err);
        }
        throw err;
      } finally {
        this.busy = undefined;
        this.emit();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private get streaming() {
    return this.webcam === 2 || this.webcam === 3;
  }

  private async get(path: string): Promise<HttpResult> {
    const r = await this.http!(path);
    if (r.status >= 400) throw new HttpError(r.status, r.body, path);
    return r;
  }

  private async connect() {
    if (this.stopped) return;
    this.phase = 'connecting';
    this.emit();
    try {
      // Webcam commands over USB require wired USB control to be off.
      await this.get('/gopro/camera/control/wired_usb?p=0');
      await this.refresh();
      this.phase = 'connected';
      this.attempt = 0;
      this.failures = 0;
      this.detail = undefined;
      this.emit();
      this.every(this.keepAliveMs, () => this.get('/gopro/camera/keep_alive'));
      this.every(this.pollMs, async () => {
        await this.refresh();
        this.emit();
      });
    } catch (err) {
      this.lost(err);
    }
  }

  /** Repeats `tick` every `ms` after the previous one settles, for the current connection only. */
  private every(ms: number, tick: () => Promise<unknown>) {
    const generation = this.generation;
    const live = () => !this.stopped && this.phase === 'connected' && generation === this.generation;
    const run = () => {
      if (!live()) return;
      tick()
        .then(
          () => {
            this.failures = 0;
          },
          (err) => {
            // One missed keep-alive is normal while the camera is busy; two in a row means it is gone.
            if (++this.failures >= 2 && live()) this.lost(err);
          },
        )
        .finally(() => {
          if (live()) this.timers.push(this.timer.set(run, ms));
        });
    };
    this.timers.push(this.timer.set(run, ms));
  }

  private clearTimers() {
    this.timers.forEach((t) => this.timer.clear(t));
    this.timers = [];
  }

  private lost(err: unknown) {
    this.generation++;
    this.clearTimers();
    if (this.stopped) return;
    this.phase = 'disconnected';
    this.webcam = WEBCAM_OFF;
    const why = err instanceof Error ? err.message : String(err);
    this.detail = `GoPro not reachable at ${this.cfg.host} (${why}). Is it plugged in over USB and switched on?`;
    this.emit();
    const ceiling = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.timers.push(this.timer.set(() => void this.connect(), ceiling / 2 + this.rand() * (ceiling / 2)));
  }

  private async refresh() {
    const state = (await this.get('/gopro/camera/state')).body as {
      status?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    } | null;
    const battery = state?.status?.[STATUS_BATTERY_PERCENT];
    this.battery = typeof battery === 'number' ? battery : undefined;
    const hot = state?.status?.[STATUS_SYSTEM_HOT];
    this.hot = typeof hot === 'number' ? hot === 1 : undefined;
    for (const id of [SETTING_ANTI_FLICKER, SETTING_HYPERSMOOTH]) {
      const v = state?.settings?.[id];
      if (typeof v === 'number') this.settings[id] = String(v);
    }
    await this.refreshWebcam();
  }

  private async refreshWebcam() {
    const wc = (await this.get('/gopro/webcam/status')).body as { status?: unknown; error?: unknown } | null;
    this.webcam = typeof wc?.status === 'number' ? wc.status : WEBCAM_OFF;
    this.webcamError = typeof wc?.error === 'number' && wc.error !== 0 ? WEBCAM_ERRORS[wc.error] : undefined;
  }

  private async apply(key: string, value: ControlValue) {
    if (this.phase !== 'connected') throw new RangeError('the GoPro is not connected');
    const pick = (options: Option[]) => {
      if (typeof value !== 'string' || !options.some((o) => o.value === value)) {
        throw new RangeError(`unsupported value ${JSON.stringify(value)}`);
      }
      return value;
    };
    switch (key) {
      case 'webcam':
        if (typeof value !== 'boolean') throw new RangeError('webcam needs true or false');
        if (value) await this.startWebcam();
        else await this.get('/gopro/webcam/stop');
        break;
      case 'resolution':
        this.resolution = pick(RESOLUTIONS);
        if (this.streaming) await this.restartWebcam();
        break;
      case 'lens':
        this.lens = pick(LENSES);
        if (this.streaming) await this.restartWebcam();
        break;
      case 'hypersmooth': {
        const option = pick(this.options(SETTING_HYPERSMOOTH));
        // HyperSmooth can only change while webcam mode is fully exited.
        const wasStreaming = this.streaming;
        if (this.webcam !== WEBCAM_OFF) {
          if (wasStreaming) await this.get('/gopro/webcam/stop');
          await this.get('/gopro/webcam/exit');
        }
        await this.setSetting(SETTING_HYPERSMOOTH, option);
        if (wasStreaming) await this.startWebcam();
        break;
      }
      case 'antiflicker':
        await this.setSetting(SETTING_ANTI_FLICKER, pick(this.options(SETTING_ANTI_FLICKER)));
        break;
      case 'zoom': {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('zoom needs a number');
        const percent = Math.round(Math.min(100, Math.max(0, value)));
        await this.get(`/gopro/camera/digital_zoom?percent=${percent}`);
        this.zoom = percent;
        break;
      }
      default:
        throw new RangeError(`unknown control ${key}`);
    }
    await this.refreshWebcam();
  }

  private async startWebcam() {
    const q = `res=${this.resolution}&fov=${this.lens}&port=${this.cfg.port}&protocol=TS`;
    await this.get(`/gopro/webcam/start?${q}`);
  }

  private async restartWebcam() {
    await this.get('/gopro/webcam/stop');
    await this.startWebcam();
  }

  private async setSetting(id: number, option: string) {
    const path = `/gopro/camera/setting?setting=${id}&option=${option}`;
    const r = await this.http!(path);
    if (r.status === 403) {
      const accepted = optionsFrom(r.body);
      if (accepted) this.accepted.set(id, accepted);
      throw new HttpError(403, r.body, path);
    }
    if (r.status >= 400) throw new HttpError(r.status, r.body, path);
    this.settings[id] = option;
  }

  private options(setting: number): Option[] {
    const accepted = this.accepted.get(setting);
    if (accepted) return accepted;
    if (setting === SETTING_HYPERSMOOTH) return HYPERSMOOTH;
    return this.settings[SETTING_ANTI_FLICKER] === '0' || this.settings[SETTING_ANTI_FLICKER] === '1'
      ? FLICKER_TV
      : FLICKER_HZ;
  }

  private controls(): CameraControl[] {
    const off = this.phase === 'connected' ? (this.busy ? 'Applying a change…' : undefined) : 'GoPro is not connected';
    const select = (key: string, label: string, value: string | undefined, options: Option[], hint?: string): CameraControl => ({
      key,
      label,
      kind: 'select',
      value: value ?? '',
      options,
      ...(hint ? { hint } : {}),
      ...(off ? { disabled: off } : {}),
    });
    return [
      { key: 'webcam', label: 'Webcam stream', kind: 'toggle', value: this.streaming, ...(off ? { disabled: off } : {}) },
      select('resolution', 'Resolution', this.resolution, RESOLUTIONS, 'Restarts the stream'),
      select('lens', 'Lens', this.lens, LENSES, 'Restarts the stream'),
      select('hypersmooth', 'HyperSmooth', this.settings[SETTING_HYPERSMOOTH], this.options(SETTING_HYPERSMOOTH), 'Restarts the webcam to apply'),
      select('antiflicker', 'Anti-flicker', this.settings[SETTING_ANTI_FLICKER], this.options(SETTING_ANTI_FLICKER), 'Match your mains frequency'),
      {
        key: 'zoom',
        label: 'Digital zoom',
        kind: 'range',
        value: this.zoom,
        min: 0,
        max: 100,
        step: 1,
        hint: 'May not apply while in webcam mode',
        ...(off ? { disabled: off } : {}),
      },
    ];
  }

  private emit() {
    const status =
      this.phase === 'connected'
        ? this.streaming
          ? 'streaming'
          : 'ready'
        : this.phase === 'disconnected'
          ? 'disconnected'
          : this.phase === 'misconfigured'
            ? 'error'
            : 'connecting';
    const detail = this.detail ?? (this.phase === 'connected' ? this.webcamError && `Webcam: ${this.webcamError}` : undefined);
    const telemetry = this.phase === 'connected' && (this.battery !== undefined || this.hot !== undefined)
      ? { ...(this.battery !== undefined ? { battery: this.battery } : {}), ...(this.hot !== undefined ? { overheating: this.hot } : {}) }
      : undefined;
    this.report({
      status,
      ...(detail ? { detail } : {}),
      ...(telemetry ? { telemetry } : {}),
      controls: this.controls(),
      obsInput: {
        kind: 'ffmpeg_source',
        settings: {
          is_local_file: false,
          input: `udp://@:${this.cfg.port}`,
          input_format: 'mpegts',
          buffering_mb: 1,
          hw_decode: true,
          close_when_inactive: false,
          restart_on_activate: false,
          clear_on_media_end: false,
        },
      },
    });
  }
}
