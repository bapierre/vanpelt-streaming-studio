import { describe, expect, it } from 'vitest';
import type { DeviceReport } from '@streamhub/camera-sdk';
import { GoProDevice, parseConfig, usbHost, type GoProHttp, type Timer } from './gopro';

/** Simulates the Open GoPro HTTP API of a HERO12 on USB. */
class FakeGoPro {
  reachable = true;
  webcam = 0;
  settings: Record<number, number> = { 134: 2, 135: 0 };
  battery = 87;
  hot = 0;
  encoding = 0;
  /** Whether the shutter starts encoding; some models may refuse while the webcam runs. */
  shutterWorks = true;
  /** setting id → options it accepts; anything else gets a 403 listing them. */
  accepts: Record<number, Array<{ id: number; display_name: string }>> = {};
  log: string[] = [];

  http: GoProHttp = async (path) => {
    if (!this.reachable) throw new Error('connect EHOSTUNREACH');
    this.log.push(path);
    const url = new URL(`http://cam${path}`);
    const q = (k: string) => Number(url.searchParams.get(k));
    switch (url.pathname) {
      case '/gopro/camera/state':
        return {
          status: 200,
          body: { status: { 6: this.hot, 10: this.encoding, 70: this.battery }, settings: this.settings },
        };
      case '/gopro/camera/shutter/start':
        if (this.shutterWorks) this.encoding = 1;
        return { status: 200, body: {} };
      case '/gopro/camera/shutter/stop':
        this.encoding = 0;
        return { status: 200, body: {} };
      case '/gopro/webcam/status':
        return { status: 200, body: { status: this.webcam, error: 0 } };
      case '/gopro/webcam/start':
        this.webcam = 2;
        return { status: 200, body: {} };
      case '/gopro/webcam/stop':
        this.webcam = 1;
        return { status: 200, body: {} };
      case '/gopro/webcam/exit':
        this.webcam = 0;
        return { status: 200, body: {} };
      case '/gopro/camera/setting': {
        const id = q('setting');
        const allowed = this.accepts[id];
        if (allowed && !allowed.some((o) => o.id === q('option'))) {
          return { status: 403, body: { supported_options: allowed } };
        }
        if (id === 135 && this.webcam !== 0) return { status: 403, body: {} };
        this.settings[id] = q('option');
        return { status: 200, body: {} };
      }
      default:
        return { status: 200, body: {} };
    }
  };
}

class Timers implements Timer {
  queue: Array<{ fn: () => void; ms: number }> = [];
  set(fn: () => void, ms: number) {
    const e = { fn, ms };
    this.queue.push(e);
    return e;
  }
  clear(h: unknown) {
    this.queue = this.queue.filter((e) => e !== h);
  }
  fire(ms: number) {
    const i = this.queue.findIndex((e) => e.ms === ms);
    if (i < 0) throw new Error(`no timer at ${ms}`);
    this.queue.splice(i, 1)[0]!.fn();
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function setup(config: Record<string, unknown> = { serial: 'C3501324567890' }) {
  const cam = new FakeGoPro();
  const timers = new Timers();
  const reports: DeviceReport[] = [];
  const device = new GoProDevice({ id: 'gopro', name: 'GoPro', config }, (r) => reports.push(r), {
    http: cam.http,
    timer: timers,
    rand: () => 0,
    keepAliveMs: 3000,
    pollMs: 5000,
  });
  const last = () => reports[reports.length - 1]!;
  const control = (key: string) => last().controls.find((c) => c.key === key);
  return { cam, timers, reports, device, last, control };
}

describe('usbHost', () => {
  it('builds 172.2X.1YZ.51 from the last three serial digits', () => {
    expect(usbHost('C0000123456789')).toBe('172.27.189.51');
    expect(usbHost('C35013245678')).toBe('172.26.178.51');
    expect(usbHost('nope')).toBeNull();
  });
  it('prefers an explicit host and reads friendly defaults', () => {
    expect(parseConfig({ host: '10.0.0.5', serial: 'C123', resolution: '720p', lens: 'linear' })).toEqual({
      host: '10.0.0.5',
      port: 8554,
      resolution: '7',
      lens: '4',
    });
  });
});

describe('GoProDevice', () => {
  it('explains missing configuration instead of connecting', () => {
    const t = setup({});
    t.device.start();
    expect(t.last()).toMatchObject({ status: 'error', detail: expect.stringContaining('serial') });
    expect(t.cam.log).toEqual([]);
  });

  it('connects: disables wired USB control, reads state and reports telemetry', async () => {
    const t = setup();
    t.device.start();
    expect(t.last().status).toBe('connecting');
    await settle();
    expect(t.cam.log[0]).toBe('/gopro/camera/control/wired_usb?p=0');
    expect(t.last()).toMatchObject({ status: 'ready', telemetry: { battery: 87, overheating: false } });
    expect(t.control('antiflicker')).toMatchObject({ value: '2', options: [{ label: '60 Hz' }, { label: '50 Hz' }] });
    expect(t.control('webcam')).toMatchObject({ value: false });
    expect(t.control('webcam')?.disabled).toBeUndefined();
    expect(t.last().obsInput).toMatchObject({ kind: 'ffmpeg_source', settings: { input: 'udp://@:8554' } });
  });

  it('starts the webcam with the chosen resolution, lens and port over TS', async () => {
    const t = setup({ serial: 'C3501324567890', port: 8556 });
    t.device.start();
    await settle();
    await t.device.set('lens', '4');
    await t.device.set('webcam', true);
    expect(t.cam.log).toContain('/gopro/webcam/start?res=12&fov=4&port=8556&protocol=TS');
    expect(t.last().status).toBe('streaming');
  });

  it('restarts a running stream when the resolution changes', async () => {
    const t = setup();
    t.device.start();
    await settle();
    await t.device.set('webcam', true);
    t.cam.log = [];
    await t.device.set('resolution', '7');
    expect(t.cam.log.filter((p) => /^\/gopro\/webcam\/(stop|start)/.test(p))).toEqual([
      '/gopro/webcam/stop',
      '/gopro/webcam/start?res=7&fov=0&port=8554&protocol=TS',
    ]);
  });

  it('exits webcam mode to change HyperSmooth, then resumes streaming', async () => {
    const t = setup();
    t.device.start();
    await settle();
    await t.device.set('webcam', true);
    t.cam.log = [];
    await t.device.set('hypersmooth', '4');
    expect(t.cam.log.slice(0, 4)).toEqual([
      '/gopro/webcam/stop',
      '/gopro/webcam/exit',
      '/gopro/camera/setting?setting=135&option=4',
      '/gopro/webcam/start?res=12&fov=0&port=8554&protocol=TS',
    ]);
    expect(t.control('hypersmooth')).toMatchObject({ value: '4' });
    expect(t.last().status).toBe('streaming');
  });

  it('learns the accepted options when the camera rejects one', async () => {
    const t = setup();
    t.cam.accepts[134] = [
      { id: 0, display_name: 'NTSC' },
      { id: 1, display_name: 'PAL' },
    ];
    t.device.start();
    await settle();
    await expect(t.device.set('antiflicker', '3')).rejects.toThrow('403');
    expect(t.last()).toMatchObject({ status: 'ready', detail: expect.stringContaining('antiflicker') });
    expect(t.control('antiflicker')).toMatchObject({ options: [{ value: '0', label: 'NTSC' }, { value: '1', label: 'PAL' }] });
    await t.device.set('antiflicker', '1');
    expect(t.last().detail).toBeUndefined();
  });

  it('rejects values outside the offered options without calling the camera', async () => {
    const t = setup();
    t.device.start();
    await settle();
    t.cam.log = [];
    await expect(t.device.set('lens', '99')).rejects.toThrow('unsupported');
    await expect(t.device.set('webcam', 'yes')).rejects.toThrow();
    expect(t.cam.log).toEqual([]);
    expect(t.last().status).toBe('ready');
  });

  it('keeps the camera awake every 3 s and polls status every 5 s', async () => {
    const t = setup();
    t.device.start();
    await settle();
    t.cam.battery = 40;
    t.timers.fire(3000);
    t.timers.fire(5000);
    await settle();
    expect(t.cam.log).toContain('/gopro/camera/keep_alive');
    expect(t.last().telemetry).toMatchObject({ battery: 40 });
    expect(t.timers.queue.map((e) => e.ms).sort()).toEqual([3000, 5000]); // both loops rescheduled once
  });

  it('reports a lost camera after two missed keep-alives and reconnects with backoff', async () => {
    const t = setup();
    t.device.start();
    await settle();
    t.cam.reachable = false;
    t.timers.fire(3000);
    await settle();
    expect(t.last().status).toBe('ready'); // one miss is tolerated
    t.timers.fire(3000);
    await settle();
    expect(t.last()).toMatchObject({ status: 'disconnected', detail: expect.stringContaining('172.28.190.51') });
    expect(t.control('webcam')?.disabled).toBe('GoPro is not connected');
    expect(t.timers.queue.map((e) => e.ms)).toEqual([500]); // only the reconnect timer is left
    t.cam.reachable = true;
    t.timers.fire(500);
    await settle();
    expect(t.last().status).toBe('ready');
  });

  it('keeps retrying when the camera is unplugged at startup', async () => {
    const t = setup();
    t.cam.reachable = false;
    t.device.start();
    await settle();
    expect(t.last().status).toBe('disconnected');
    t.timers.fire(500);
    await settle();
    expect(t.timers.queue.map((e) => e.ms)).toEqual([1000]);
  });

  it('refuses changes while disconnected without hiding why', async () => {
    const t = setup();
    t.cam.reachable = false;
    t.device.start();
    await settle();
    await expect(t.device.set('webcam', true)).rejects.toThrow('not connected');
    expect(t.last().detail).toContain('not reachable');
  });

  it('leaves the webcam running when the driver stops', async () => {
    const t = setup();
    t.device.start();
    await settle();
    await t.device.set('webcam', true);
    await t.device.stop();
    expect(t.cam.webcam).toBe(2);
    expect(t.timers.queue).toEqual([]);
  });

  it('records to the card with the shutter and reports it from the encoding status', async () => {
    const t = setup();
    t.device.start();
    await settle();
    expect(t.last().card).toEqual({ supported: true, recording: false });
    await t.device.record(true);
    expect(t.cam.log).toContain('/gopro/camera/shutter/start');
    expect(t.last().card).toEqual({ supported: true, recording: true });
    await t.device.record(false);
    expect(t.cam.log).toContain('/gopro/camera/shutter/stop');
    expect(t.last().card).toEqual({ supported: true, recording: false });
  });

  it('says so when the shutter is accepted but the card is not recording', async () => {
    const t = setup();
    t.cam.shutterWorks = false;
    t.device.start();
    await settle();
    await t.device.record(true);
    expect(t.last().card).toMatchObject({ recording: false, detail: expect.stringContaining('not recording') });
  });

  it('explains a card record request while disconnected', async () => {
    const t = setup();
    t.cam.reachable = false;
    t.device.start();
    await settle();
    await expect(t.device.record(true)).rejects.toThrow('not connected');
    expect(t.last().card).toMatchObject({ recording: false, detail: expect.stringContaining('did not start') });
  });
});
