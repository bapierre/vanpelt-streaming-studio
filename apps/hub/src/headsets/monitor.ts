/** The filter kind registered by Exeldro's Audio Monitor plugin. */
export const AUDIO_MONITOR_KIND = 'audio_monitor';
export const AUDIO_MONITOR_URL = 'https://obsproject.com/forum/resources/audio-monitor.1186/';

const FILTER_PREFIX = 'streamhub hp ';
export const headsetFilterName = (headsetId: string) => `${FILTER_PREFIX}${headsetId}`;
export const isHeadsetFilter = (name: unknown): name is string => typeof name === 'string' && name.startsWith(FILTER_PREFIX);
export const headsetIdOfFilter = (name: string) => name.slice(FILTER_PREFIX.length);

// The plugin stores its level as a 0–100 % slider on OBS's log fader curve (the same constants as OBS's mixer).
const LOG_OFFSET_DB = 6;
const LOG_RANGE_DB = 96;
const LOG_OFFSET_VAL = -Math.log10(LOG_OFFSET_DB);
const LOG_RANGE_VAL = -Math.log10(LOG_RANGE_DB + LOG_OFFSET_DB);

/** dB (≤ 0) to the plugin's `volume` setting, in %. */
export function dbToMonitorVolume(db: number): number {
  if (db >= 0) return 100;
  if (db <= -LOG_RANGE_DB) return 0;
  return ((-Math.log10(-db + LOG_OFFSET_DB) - LOG_RANGE_VAL) / (LOG_OFFSET_VAL - LOG_RANGE_VAL)) * 100;
}

/** The plugin's `volume` setting (%) back to dB; 0 % is silence. */
export function monitorVolumeToDb(volume: number): number {
  const def = volume / 100;
  if (def >= 1) return 0;
  if (def <= 0) return -Infinity;
  return -(LOG_RANGE_DB + LOG_OFFSET_DB) * ((LOG_RANGE_DB + LOG_OFFSET_DB) / LOG_OFFSET_DB) ** -def + LOG_OFFSET_DB;
}

/**
 * Settings for one headset send. The plugin finds the output by `deviceName` when `device` is not a
 * known device id, so passing the name in both works without knowing the OS device id. `mute: 0`
 * (never) keeps the plugin from following or changing the mic's OBS mute; the hub handles that.
 */
export function monitorSettings(device: string, volume: number): Record<string, unknown> {
  return { device, deviceName: device, volume, mute: 0, linked: false };
}
