import type { CardStatus, IsoStatus, RecordingSession } from '@streamhub/shared';

export const isRecording = (r: RecordingSession | null) => r?.output === 'recording' || r?.output === 'paused';

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** One line for the disk, or null when there is nothing worth saying. */
export function diskWarning(r: RecordingSession | null): string | null {
  const d = r?.disk;
  if (!d || d.level === 'ok') return null;
  const left = d.minutesLeft !== undefined ? ` (about ${formatMinutes(d.minutesLeft)} left)` : '';
  return `${d.level === 'critical' ? 'Disk almost full' : 'Disk space low'}: ${formatBytes(d.freeBytes)} free${left}`;
}

export const ISO_LABEL: Record<IsoStatus, string> = {
  ready: 'ready',
  recording: 'recording',
  offline: 'OBS offline',
  'no-plugin': 'plugin missing',
  'no-source': 'source missing',
  error: 'error',
};

export const CARD_LABEL: Record<CardStatus, string> = {
  ready: 'ready',
  recording: 'recording',
  unsupported: 'not supported',
  offline: 'camera offline',
  error: 'error',
};

export const fileName = (location: string) => location.split(/[\\/]/).pop() || location;
