import type { CameraControl, ControlValue } from '@streamhub/shared';

/** Requests go through the OBS bridge's connection. */
export type ObsCalls = { call(requestType: string, requestData?: object): Promise<unknown> };

export const COLOR_FILTER = 'streamhub color';
const COLOR_FILTER_KIND = 'color_filter_v2';
/** obs-websocket RequestStatus.ResourceNotFound */
const RESOURCE_NOT_FOUND = 600;

const COLOR = {
  brightness: { label: 'Brightness', min: -1, max: 1 },
  contrast: { label: 'Contrast', min: -2, max: 2 },
  saturation: { label: 'Saturation', min: -1, max: 2 },
  gamma: { label: 'Gamma', min: -1, max: 1 },
} as const;
type ColorKey = keyof typeof COLOR;
const COLOR_KEYS = Object.keys(COLOR) as ColorKey[];

const CROP = { cropLeft: 'Crop left', cropRight: 'Crop right', cropTop: 'Crop top', cropBottom: 'Crop bottom' } as const;
type CropKey = keyof typeof CROP;
const CROP_KEYS = Object.keys(CROP) as CropKey[];

type Transform = {
  positionX: number;
  scaleX: number;
  alignment: number;
  boundsType: string;
  boundsWidth: number;
  width: number;
  sourceWidth: number;
  sourceHeight: number;
} & Record<CropKey, number>;

export type ObsSide = {
  sceneItemId: number;
  color: Record<ColorKey, number>;
  crop: Record<CropKey, number>;
  mirrored: boolean;
  sourceWidth: number;
  sourceHeight: number;
};

export type ObsBinding = { scene: string; source: string };

export function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === RESOURCE_NOT_FOUND;
}

const zeroColor = (): Record<ColorKey, number> => ({ brightness: 0, contrast: 0, saturation: 0, gamma: 0 });

export async function readObsSide(obs: ObsCalls, b: ObsBinding): Promise<ObsSide> {
  const { sceneItemId } = (await obs.call('GetSceneItemId', { sceneName: b.scene, sourceName: b.source })) as {
    sceneItemId: number;
  };
  const t = await readTransform(obs, b.scene, sceneItemId);
  const color = zeroColor();
  try {
    const { filterSettings } = (await obs.call('GetSourceFilter', {
      sourceName: b.source,
      filterName: COLOR_FILTER,
    })) as { filterSettings: Record<string, unknown> };
    for (const k of COLOR_KEYS) if (typeof filterSettings[k] === 'number') color[k] = filterSettings[k];
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return {
    sceneItemId,
    color,
    crop: { cropLeft: t.cropLeft, cropRight: t.cropRight, cropTop: t.cropTop, cropBottom: t.cropBottom },
    mirrored: t.scaleX < 0,
    sourceWidth: t.sourceWidth,
    sourceHeight: t.sourceHeight,
  };
}

async function readTransform(obs: ObsCalls, sceneName: string, sceneItemId: number): Promise<Transform> {
  const { sceneItemTransform } = (await obs.call('GetSceneItemTransform', { sceneName, sceneItemId })) as {
    sceneItemTransform: Transform;
  };
  return sceneItemTransform;
}

const round = (n: number, step: number) => Math.round(n / step) * step;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function obsControls(side: ObsSide): CameraControl[] {
  // Sources that are not delivering frames report 0×0; fall back to 1080p so crop stays usable.
  const w = side.sourceWidth || 1920;
  const h = side.sourceHeight || 1080;
  return [
    ...COLOR_KEYS.map((k): CameraControl => ({
      key: `obs.${k}`,
      label: COLOR[k].label,
      kind: 'range',
      value: side.color[k],
      min: COLOR[k].min,
      max: COLOR[k].max,
      step: 0.01,
    })),
    { key: 'obs.mirror', label: 'Mirror', kind: 'toggle', value: side.mirrored },
    ...CROP_KEYS.map((k): CameraControl => ({
      key: `obs.${k}`,
      label: CROP[k],
      kind: 'range',
      value: side.crop[k],
      min: 0,
      max: Math.floor((k === 'cropLeft' || k === 'cropRight' ? w : h) / 2),
      step: 1,
    })),
    { key: 'obs.reset', label: 'Reset picture', kind: 'action', hint: 'Clears color, crop and mirror' },
  ];
}

export const isObsSideKey = (key: string) =>
  key === 'obs.mirror' ||
  key === 'obs.reset' ||
  COLOR_KEYS.some((k) => key === `obs.${k}`) ||
  CROP_KEYS.some((k) => key === `obs.${k}`);

/** Applies one OBS-side control and returns the updated values. Throws on an invalid value. */
export async function applyObsControl(
  obs: ObsCalls,
  b: ObsBinding,
  side: ObsSide,
  key: string,
  value: ControlValue,
): Promise<ObsSide> {
  const name = key.slice('obs.'.length);
  if (name === 'reset') {
    const reset = { ...side, color: zeroColor() };
    await writeColor(obs, b, reset.color);
    await obs.call('SetSceneItemTransform', {
      sceneName: b.scene,
      sceneItemId: side.sceneItemId,
      sceneItemTransform: { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 },
    });
    reset.crop = { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
    return side.mirrored ? setMirror(obs, b, reset, false) : reset;
  }
  if (name === 'mirror') {
    if (typeof value !== 'boolean') throw new Error('mirror needs true or false');
    return value === side.mirrored ? side : setMirror(obs, b, side, value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} needs a number`);
  if ((COLOR_KEYS as string[]).includes(name)) {
    const k = name as ColorKey;
    const color = { ...side.color, [k]: round(clamp(value, COLOR[k].min, COLOR[k].max), 0.01) };
    await writeColor(obs, b, color);
    return { ...side, color };
  }
  if ((CROP_KEYS as string[]).includes(name)) {
    const k = name as CropKey;
    const limit = obsControls(side).find((c) => c.key === key);
    const px = Math.round(clamp(value, 0, limit?.kind === 'range' ? limit.max : 0));
    await obs.call('SetSceneItemTransform', {
      sceneName: b.scene,
      sceneItemId: side.sceneItemId,
      sceneItemTransform: { [k]: px },
    });
    return { ...side, crop: { ...side.crop, [k]: px } };
  }
  throw new Error(`unknown OBS control ${key}`);
}

async function writeColor(obs: ObsCalls, b: ObsBinding, color: Record<ColorKey, number>) {
  try {
    await obs.call('SetSourceFilterSettings', {
      sourceName: b.source,
      filterName: COLOR_FILTER,
      filterSettings: color,
      overlay: true,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await obs.call('CreateSourceFilter', {
      sourceName: b.source,
      filterName: COLOR_FILTER,
      filterKind: COLOR_FILTER_KIND,
      filterSettings: color,
    });
  }
}

/**
 * Flips horizontally like OBS's own "Flip Horizontal": negate scaleX, then move the anchor so the
 * picture keeps covering the same area. alignment bit 1 = left, bit 2 = right, neither = centre.
 */
async function setMirror(obs: ObsCalls, b: ObsBinding, side: ObsSide, mirrored: boolean): Promise<ObsSide> {
  const t = await readTransform(obs, b.scene, side.sceneItemId);
  const width = t.boundsType !== 'OBS_BOUNDS_NONE' ? t.boundsWidth : Math.abs(t.width);
  const anchorShift = t.alignment & 1 ? width : t.alignment & 2 ? -width : 0;
  await obs.call('SetSceneItemTransform', {
    sceneName: b.scene,
    sceneItemId: side.sceneItemId,
    sceneItemTransform: {
      scaleX: mirrored ? -Math.abs(t.scaleX) : Math.abs(t.scaleX),
      positionX: t.positionX + (mirrored ? anchorShift : -anchorShift),
    },
  });
  return { ...side, mirrored };
}
