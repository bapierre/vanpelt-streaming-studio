import type { Envelope, EventPayload } from '@streamhub/shared';
import type { Bus } from '../bus/bus';
import type { ObsCalls } from '../cameras/obs-side';
import { describeError } from '../util/errors';
import { realTimer, type Timer } from '../util/timer';

/** What OBS can be asked to produce (GetVersion's supportedImageFormats). */
type ImageFormat = 'jpg' | 'jpeg' | 'png';

export type PreviewOptions = {
  bus: Bus;
  /** The OBS bridge: its call timeout keeps a hung request from stalling the round-robin. */
  obs: ObsCalls;
  timer?: Timer;
  now?: () => number;
  log?: (msg: string) => void;
  /** Thumbnail box; OBS scales to inner within it, keeping the source's aspect. */
  width?: number;
  height?: number;
};

/** Stop capturing this long after the last lease, so a closed tab does not keep OBS rendering thumbnails. */
export const LEASE_MS = 12_000;
/** The program scene is the picture people look at; the rest are just orientation. */
export const PROGRAM_MS = 1_000;
export const OTHER_MS = 4_000;
export const PREVIEW_WIDTH = 320;
export const PREVIEW_HEIGHT = 180;

const DATA_URL: Record<ImageFormat, string> = { jpg: 'data:image/jpeg;base64,', jpeg: 'data:image/jpeg;base64,', png: 'data:image/png;base64,' };

/**
 * Captures scene thumbnails from OBS for the dashboard's Live tab, but only while some dashboard
 * is watching (the `obs.cmd.previews.watch` lease). The program scene is captured about once a
 * second, the others round-robin about every four seconds, never more than one request in flight.
 * Everything here fails soft: OBS away or an erroring request only skips a capture.
 */
export class PreviewService {
  private running = false;
  private connected = false;
  private scenes: string[] = [];
  private program: string | null = null;
  /** Epoch ms of the last lease; 0 means nobody has ever asked. */
  private leaseAt = 0;
  private format: ImageFormat = 'png';
  private handle: unknown = null;
  private flight = false;
  /** Epoch ms of the last capture attempt per class; an attempt spends its cadence slot even when it fails. */
  private programAt = 0;
  private otherAt = 0;
  private cursor = 0;
  private failStreak = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly timer: Timer;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: PreviewOptions) {
    this.timer = opts.timer ?? realTimer;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
  }

  start() {
    this.running = true;
    const topics = ['obs.connection', 'obs.scenes.list', 'obs.scene.changed', 'obs.cmd.previews.watch'];
    for (const e of this.opts.bus.retainedFor(topics)) this.onEvent(e);
    this.unsubscribe = this.opts.bus.subscribe(topics, (e) => this.onEvent(e));
  }

  stop() {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disarm();
  }

  /** True while a lease is fresh enough that captures should keep running. */
  private active(): boolean {
    return this.running && this.connected && this.now() - this.leaseAt <= LEASE_MS;
  }

  private onEvent(e: Envelope) {
    switch (e.type) {
      case 'obs.connection': {
        this.connected = (e.payload as EventPayload<'obs.connection'>).connected;
        if (this.connected) {
          // The format is read before arming so the first capture already uses the right one.
          void this.readFormats().then(() => this.arm());
        } else {
          this.disarm();
        }
        return;
      }
      case 'obs.scenes.list': {
        const p = e.payload as EventPayload<'obs.scenes.list'>;
        this.scenes = p.scenes;
        this.program = p.current;
        this.arm();
        return;
      }
      case 'obs.scene.changed': {
        const p = e.payload as EventPayload<'obs.scene.changed'>;
        if (p.scene === this.program) return;
        this.program = p.scene;
        // A fresh cut is the picture everyone wants to see next: make it due at once and retime.
        this.programAt = 0;
        this.disarm();
        this.arm();
        return;
      }
      case 'obs.cmd.previews.watch':
        this.leaseAt = this.now();
        this.arm();
        return;
    }
  }

  private disarm() {
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
  }

  /** Schedule the next capture at the earliest time something is due; at most one timer is ever pending. */
  private arm() {
    if (this.handle !== null || this.flight || !this.active()) return;
    const now = this.now();
    let due = Infinity;
    if (this.program !== null) due = Math.min(due, this.programAt + PROGRAM_MS);
    if (this.others().length > 0) due = Math.min(due, this.otherAt + OTHER_MS);
    if (due === Infinity) return;
    this.handle = this.timer.set(() => void this.tick(), Math.max(0, due - now));
  }

  private others(): string[] {
    return this.scenes.filter((s) => s !== this.program);
  }

  private async tick(): Promise<void> {
    this.handle = null;
    if (!this.active()) return;
    const now = this.now();
    const dueProgram = this.program !== null && now - this.programAt >= PROGRAM_MS;
    const dueOther = this.others().length > 0 && now - this.otherAt >= OTHER_MS;
    if (!dueProgram && !dueOther) return this.arm();
    // The program scene wins a shared slot: it is the picture the dashboard actually watches.
    const scene = dueProgram ? this.program! : this.others()[this.cursor % this.others().length]!;
    if (scene === this.program) this.programAt = now;
    else {
      this.otherAt = now;
      this.cursor++;
    }
    this.flight = true;
    try {
      const shot = (await this.opts.obs.call('GetSourceScreenshot', {
        sourceName: scene,
        imageFormat: this.format,
        imageWidth: this.opts.width ?? PREVIEW_WIDTH,
        imageHeight: this.opts.height ?? PREVIEW_HEIGHT,
      })) as { imageData?: unknown };
      if (typeof shot.imageData !== 'string' || shot.imageData.length === 0) {
        throw new Error('OBS returned no image data');
      }
      this.noteSuccess();
      this.opts.bus.publish({
        type: 'obs.scene.preview',
        payload: { scene, image: DATA_URL[this.format] + shot.imageData, capturedAt: this.now() },
        source: 'previews',
      });
    } catch (err) {
      this.noteFailure(`capturing "${scene}"`, err);
    } finally {
      this.flight = false;
      this.arm();
    }
  }

  private async readFormats(): Promise<void> {
    try {
      const v = (await this.opts.obs.call('GetVersion')) as { supportedImageFormats?: unknown };
      const formats = Array.isArray(v.supportedImageFormats)
        ? v.supportedImageFormats.filter((f): f is string => typeof f === 'string')
        : [];
      this.format = formats.includes('jpg') ? 'jpg' : formats.includes('jpeg') ? 'jpeg' : 'png';
    } catch (err) {
      this.noteFailure('reading image formats', err);
    }
  }

  private noteSuccess() {
    this.failStreak = 0;
  }

  /** One line per streak of failures: OBS being down for a minute must not fill the log. */
  private noteFailure(what: string, err: unknown) {
    this.failStreak++;
    if (this.failStreak === 1) this.log(`[previews] ${what} failed: ${describeError(err)}`);
  }
}
