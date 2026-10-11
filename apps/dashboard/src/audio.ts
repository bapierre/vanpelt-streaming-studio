import type { AudioDevices, AudioLevels, AudioState, Envelope, MicState } from '@streamhub/shared';

export type AudioView = { state: AudioState | null; devices: AudioDevices | null };

export function reduceAudio(view: AudioView, event: Envelope): AudioView {
  if (event.type === 'audio.state') return { ...view, state: event.payload as AudioState };
  if (event.type === 'audio.devices') return { ...view, devices: event.payload as AudioDevices };
  return view;
}

export type Levels = AudioLevels['levels'];

/** The meter shows −60…0 dBFS; anything quieter is an empty bar. */
export const METER_FLOOR_DB = -60;
export const meterPercent = (db: number) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
/** Speech should sit in the green; yellow is loud; red is close to clipping. */
export const meterZone = (db: number) => (db >= -6 ? 'hot' : db >= -18 ? 'loud' : 'ok');

/** Fader range in the dashboard; OBS allows −100…+26 dB but nobody needs that on a show. */
export const FADER_MIN_DB = -60;
export const FADER_MAX_DB = 12;
export const formatDb = (db: number) => (db <= -100 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`);

export function trackLabel(mic: MicState): string {
  return mic.track === null ? 'Mix only (no isolated track left)' : `Track ${mic.track}`;
}

export function micWarning(mic: MicState): string | undefined {
  if (mic.status === 'offline') return 'OBS is not connected';
  if (mic.status === 'missing') return mic.detail ?? 'Not found in OBS';
  if (mic.detail) return mic.detail;
  if (!mic.live) return 'Not in the live scene: the stream cannot hear it';
  return undefined;
}

export const SPLIT_HINT =
  'Split mic: in OBS, open Edit → Advanced Audio Properties and tick Mono for this input so this side plays in both ears.';
