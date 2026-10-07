import { describe, expect, it } from 'vitest';
import type { CameraState, Envelope } from '@streamhub/shared';
import { Bus } from '../bus/bus';
import type { CameraConfig } from './config';
import { COLOR_FILTER, type ObsCalls } from './obs-side';
import { CameraService } from './service';

const notFound = () => Object.assign(new Error('not found'), { code: 600 });

const transform = (over: Record<string, unknown> = {}) => ({
  positionX: 0,
  scaleX: 1,
  alignment: 5, // top-left
  boundsType: 'OBS_BOUNDS_NONE',
  boundsWidth: 0,
  width: 1920,
  sourceWidth: 1920,
  sourceHeight: 1080,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  ...over,
});

/** Fake OBS holding one scene item per scene/source pair. */
function fakeObs(items: Record<string, number> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let filter: Record<string, unknown> | null = null;
  let t = transform();
  const inputs: string[] = [];
  const obs: ObsCalls = {
    async call(type, data = {}) {
      const d = data as Record<string, unknown>;
      calls.push([type, d]);
      switch (type) {
        case 'GetSceneItemId': {
          const id = items[`${d.sceneName}/${d.sourceName}`];
          if (id === undefined) throw notFound();
          return { sceneItemId: id };
        }
        case 'GetSceneItemTransform':
          return { sceneItemTransform: t };
        case 'SetSceneItemTransform':
          t = { ...t, ...(d.sceneItemTransform as object) };
          return {};
        case 'GetSourceFilter':
          if (!filter) throw notFound();
          return { filterSettings: filter };
        case 'SetSourceFilterSettings':
          if (!filter) throw notFound();
          filter = { ...filter, ...(d.filterSettings as object) };
          return {};
        case 'CreateSourceFilter':
          filter = d.filterSettings as Record<string, unknown>;
          return {};
        case 'GetInputList':
          return { inputs: inputs.map((inputName) => ({ inputName })) };
        default:
          return {};
      }
    },
  };
  return { obs, calls, items, transform: () => t };
}

const sony: CameraConfig = { id: 'sony', name: 'Sony A6400', driver: null, scene: 'Sony', source: 'Sony cam', driverConfig: {} };
const gopro: CameraConfig = { id: 'gopro', name: 'GoPro', driver: 'camera-gopro', scene: 'GoPro', source: 'GoPro feed', driverConfig: {} };

function setup(cameras: CameraConfig[], items: Record<string, number> = { 'Sony/Sony cam': 7 }, installed = ['camera-gopro']) {
  const bus = new Bus();
  const fake = fakeObs(items);
  const logs: string[] = [];
  const service = new CameraService({
    bus,
    obs: fake.obs,
    cameras,
    installedDrivers: new Set(installed),
    log: (m) => logs.push(m),
  });
  const states = new Map<string, CameraState>();
  const sent: Envelope[] = [];
  bus.subscribe(['camera.state'], (e) => states.set((e.payload as CameraState).id, e.payload as CameraState));
  bus.subscribe(['obs.cmd.', 'camera.driver.cmd.'], (e) => sent.push(e));
  service.start();
  const obsUp = async (scenes: string[], current: string) => {
    bus.publish({ type: 'obs.connection', payload: { connected: true }, source: 'obs' });
    bus.publish({ type: 'obs.scenes.list', payload: { scenes, current }, source: 'obs' });
    await service.idle();
  };
  const cmd = async (type: string, payload: unknown) => {
    expect(bus.publish({ type, payload, source: 'dashboard' })).toMatchObject({ ok: true });
    await service.idle();
  };
  return { bus, fake, service, states, sent, logs, obsUp, cmd };
}

const control = (s: CameraState | undefined, key: string) => s?.controls.find((c) => c.key === key);

describe('CameraService — OBS-only camera', () => {
  it('is disconnected until OBS is up, then ready with OBS-side controls', async () => {
    const t = setup([sony]);
    expect(t.states.get('sony')).toMatchObject({ status: 'disconnected', obsDetail: 'OBS is not connected' });
    await t.obsUp(['Sony', 'Main'], 'Main');
    const s = t.states.get('sony');
    expect(s).toMatchObject({ status: 'ready', onAir: false });
    expect(s?.obsDetail).toBeUndefined();
    expect(control(s, 'obs.brightness')).toMatchObject({ kind: 'range', value: 0, min: -1, max: 1 });
    expect(control(s, 'obs.cropLeft')).toMatchObject({ max: 960 });
  });

  it('reports a missing scene or source', async () => {
    const t = setup([sony], {});
    await t.obsUp(['Main'], 'Main');
    expect(t.states.get('sony')).toMatchObject({ status: 'error', obsDetail: 'Scene "Sony" not found in OBS' });
    await t.obsUp(['Main', 'Sony'], 'Main');
    expect(t.states.get('sony')).toMatchObject({ obsDetail: 'Source "Sony cam" is not in scene "Sony"' });
  });

  it('takes the camera by switching to its scene and tracks on-air', async () => {
    const t = setup([sony]);
    await t.obsUp(['Sony', 'Main'], 'Main');
    await t.cmd('camera.cmd.take', { id: 'sony' });
    expect(t.sent.map((e) => [e.type, e.payload])).toEqual([['obs.cmd.setScene', { scene: 'Sony' }]]);
    t.bus.publish({ type: 'obs.scene.changed', payload: { scene: 'Sony' }, source: 'obs' });
    expect(t.states.get('sony')?.onAir).toBe(true);
  });

  it('does not switch scenes while OBS is down', async () => {
    const t = setup([sony]);
    await t.cmd('camera.cmd.take', { id: 'sony' });
    expect(t.sent).toEqual([]);
  });

  it('creates the color filter on first use, then updates it', async () => {
    const t = setup([sony]);
    await t.obsUp(['Sony'], 'Sony');
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.brightness', value: 0.333 });
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.contrast', value: 9 });
    const writes = t.fake.calls.filter(([type]) => type.includes('SourceFilter') && type !== 'GetSourceFilter');
    expect(writes.map(([type]) => type)).toEqual(['SetSourceFilterSettings', 'CreateSourceFilter', 'SetSourceFilterSettings']);
    expect(writes[1]![1]).toMatchObject({ filterName: COLOR_FILTER, filterKind: 'color_filter_v2' });
    expect(control(t.states.get('sony'), 'obs.brightness')).toMatchObject({ value: 0.33 });
    expect(control(t.states.get('sony'), 'obs.contrast')).toMatchObject({ value: 2 }); // clamped
  });

  it('mirrors a top-left aligned source without moving it, and back', async () => {
    const t = setup([sony]);
    await t.obsUp(['Sony'], 'Sony');
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.mirror', value: true });
    expect(t.fake.transform()).toMatchObject({ scaleX: -1, positionX: 1920 });
    expect(control(t.states.get('sony'), 'obs.mirror')).toMatchObject({ value: true });
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.mirror', value: false });
    expect(t.fake.transform()).toMatchObject({ scaleX: 1, positionX: 0 });
  });

  it('crops within half the source size and resets everything', async () => {
    const t = setup([sony]);
    await t.obsUp(['Sony'], 'Sony');
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.cropTop', value: 5000 });
    expect(t.fake.transform()).toMatchObject({ cropTop: 540 });
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.reset', value: null });
    expect(t.fake.transform()).toMatchObject({ cropTop: 0 });
  });

  it('logs and ignores a bad value', async () => {
    const t = setup([sony]);
    await t.obsUp(['Sony'], 'Sony');
    await t.cmd('camera.cmd.set', { id: 'sony', key: 'obs.gamma', value: 'loud' });
    expect(t.logs.some((l) => l.includes('obs.gamma on sony failed'))).toBe(true);
    expect(t.states.get('sony')?.status).toBe('ready');
  });
});

describe('CameraService — driver camera', () => {
  const driverState = (over: Record<string, unknown> = {}) => ({
    id: 'gopro',
    status: 'streaming',
    telemetry: { battery: 80 },
    controls: [{ key: 'fov', label: 'Lens', kind: 'select', value: '0', options: [] }],
    obsInput: { kind: 'ffmpeg_source', settings: { input: 'udp://@:8554' } },
    ...over,
  });

  it('marks a camera whose driver module is missing', () => {
    const t = setup([gopro], {}, []);
    expect(t.states.get('gopro')).toMatchObject({
      status: 'error',
      detail: 'Driver "camera-gopro" is not installed in modules/',
    });
  });

  it('shows connecting, then merges what the driver reports', async () => {
    const t = setup([gopro], { 'GoPro/GoPro feed': 3 });
    expect(t.states.get('gopro')?.status).toBe('connecting');
    t.bus.publish({ type: 'camera.driver.state', payload: driverState(), source: 'driver:camera-gopro' });
    await t.obsUp(['GoPro'], 'GoPro');
    const s = t.states.get('gopro');
    expect(s).toMatchObject({ status: 'streaming', onAir: true, telemetry: { battery: 80 } });
    expect(s?.controls.map((c) => c.key).slice(0, 2)).toEqual(['fov', 'obs.brightness']);
  });

  it('ignores driver state from another source', () => {
    const t = setup([gopro]);
    t.bus.publish({ type: 'camera.driver.state', payload: driverState(), source: 'driver:camera-other' });
    expect(t.states.get('gopro')?.status).toBe('connecting');
  });

  it('forwards device controls to the driver', async () => {
    const t = setup([gopro]);
    t.bus.publish({ type: 'camera.driver.state', payload: driverState(), source: 'driver:camera-gopro' });
    await t.cmd('camera.cmd.set', { id: 'gopro', key: 'fov', value: '4' });
    expect(t.sent.map((e) => [e.type, e.payload])).toEqual([
      ['camera.driver.cmd.set', { id: 'gopro', key: 'fov', value: '4' }],
    ]);
  });

  it('reports an exited driver until it reports again', async () => {
    const t = setup([gopro]);
    t.bus.publish({ type: 'camera.driver.state', payload: driverState(), source: 'driver:camera-gopro' });
    t.service.driverExited('camera-gopro', 'Driver exited (code 1); restarting');
    expect(t.states.get('gopro')).toMatchObject({ status: 'error', detail: 'Driver exited (code 1); restarting', controls: [] });
    await t.cmd('camera.cmd.set', { id: 'gopro', key: 'fov', value: '4' });
    expect(t.sent).toEqual([]);
  });

  it('offers to create the OBS scene from the driver recipe', async () => {
    const t = setup([gopro], {});
    t.bus.publish({ type: 'camera.driver.state', payload: driverState(), source: 'driver:camera-gopro' });
    await t.obsUp(['Main'], 'Main');
    expect(control(t.states.get('gopro'), 'obs.createScene')).toMatchObject({ kind: 'action' });
    t.fake.items['GoPro/GoPro feed'] = 9; // what OBS will hold after the create calls
    await t.cmd('camera.cmd.set', { id: 'gopro', key: 'obs.createScene', value: null });
    const created = t.fake.calls.filter(([type]) => type.startsWith('Create'));
    expect(created).toEqual([
      ['CreateScene', { sceneName: 'GoPro' }],
      [
        'CreateInput',
        { sceneName: 'GoPro', inputName: 'GoPro feed', inputKind: 'ffmpeg_source', inputSettings: { input: 'udp://@:8554' } },
      ],
    ]);
    const s = t.states.get('gopro');
    expect(s?.obsDetail).toBeUndefined();
    expect(control(s, 'obs.createScene')).toBeUndefined();
  });
});
