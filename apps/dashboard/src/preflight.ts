import type { AlertsConfig, AudioState, CameraState, HeadsetsState, Platform, RecordingSession } from '@streamhub/shared';
import { PLATFORMS } from './platforms';
import type { TabId } from './prefs';
import { diskWarning, formatBytes, ISO_LABEL } from './recording';
import type { DashboardState } from './state';

export type CheckStatus = 'ok' | 'warn' | 'fail';
/** Where to fix it: a tab, and for Settings the section id. */
export type Fix = { tab: TabId; section?: string; label: string };
export type Check = { id: string; status: CheckStatus; title: string; detail?: string; fix?: Fix };

export type PreflightInput = {
  state: DashboardState;
  audio: AudioState | null;
  headsets: HeadsetsState | null;
  recording: RecordingSession | null;
  cameras: CameraState[];
  alerts: AlertsConfig | null;
};

const FIX = {
  obs: { tab: 'settings', section: 'obs', label: 'OBS settings' },
  keys: { tab: 'settings', section: 'destinations', label: 'Stream keys' },
  platforms: { tab: 'settings', section: 'platforms', label: 'Platforms' },
  cameras: { tab: 'settings', section: 'cameras', label: 'Cameras' },
  alerts: { tab: 'onscreen', section: 'alerts', label: 'Alerts' },
  sound: { tab: 'sound', label: 'Sound tab' },
} satisfies Record<string, Fix>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Everything worth checking before going live, from the state the hub already sends. */
export function preflightChecks({ state, audio, headsets, recording, cameras, alerts }: PreflightInput): Check[] {
  if (!state.hubConnected) {
    return [{ id: 'hub', status: 'fail', title: 'The dashboard cannot reach the hub', detail: 'Start streamhub, then wait for this page to reconnect.' }];
  }
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  if (!state.obs.connected) {
    add({ id: 'obs', status: 'fail', title: 'OBS is not connected', detail: state.obs.detail, fix: FIX.obs });
  } else {
    add({ id: 'obs', status: 'ok', title: 'OBS is connected' });
    streamKey(state, add);
  }
  platforms(state, add);
  if (state.obs.connected) {
    if (audio) mics(audio, add);
    if (headsets) headsetChecks(headsets, add);
    if (recording) recordingChecks(recording, add);
    cameraChecks(cameras, add);
  }
  if (alerts?.paused) add({ id: 'alerts', status: 'warn', title: 'Alerts are paused', detail: 'Viewers will not see follows, subs or tips.', fix: FIX.alerts });
  return checks;
}

function streamKey(state: DashboardState, add: (c: Check) => void) {
  const { destinations, inObs, obsKeySet, detail } = state.destinations;
  if (obsKeySet === false) {
    add({
      id: 'stream-key',
      status: 'fail',
      title: 'OBS has no stream key',
      detail: 'Paste one under Stream keys and click Use in OBS, or set it in OBS → Settings → Stream.',
      fix: FIX.keys,
    });
  } else if (obsKeySet) {
    const label = destinations.find((d) => d.id === inObs)?.label;
    add({ id: 'stream-key', status: 'ok', title: label ? `Streaming to ${label}` : 'OBS has a stream key' });
  }
  if (detail) add({ id: 'stream-key-detail', status: 'warn', title: 'Stream keys', detail, fix: FIX.keys });
}

function platforms(state: DashboardState, add: (c: Check) => void) {
  let connected = 0;
  let problems = 0;
  for (const [platform, c] of Object.entries(state.connections) as [Platform, DashboardState['connections'][Platform]][]) {
    if (!c) continue;
    const name = PLATFORMS[platform].label;
    if (c.state === 'connected') {
      const status = state.platforms[platform];
      if (status?.status === 'error') {
        problems++;
        add({ id: `platform-${platform}`, status: 'warn', title: `${name} chat has a problem`, detail: status.detail, fix: FIX.platforms });
      } else {
        connected++;
        add({ id: `platform-${platform}`, status: 'ok', title: `${name} is connected` });
      }
    } else if (c.state === 'error') {
      problems++;
      add({ id: `platform-${platform}`, status: 'warn', title: `${name} needs to reconnect`, detail: c.detail, fix: FIX.platforms });
    } else if (c.state === 'pending') {
      problems++;
      add({ id: `platform-${platform}`, status: 'warn', title: `${name} sign-in is not finished`, fix: FIX.platforms });
    }
  }
  if (connected === 0 && problems === 0) {
    add({ id: 'platforms', status: 'warn', title: 'No platform is connected', detail: 'Chat and alerts will stay empty.', fix: FIX.platforms });
  }
}

function mics(audio: AudioState, add: (c: Check) => void) {
  if (audio.mics.length === 0) {
    add({ id: 'mics', status: 'warn', title: 'No mics are set up', fix: FIX.sound });
    return;
  }
  let ready = 0;
  for (const mic of audio.mics) {
    const id = `mic-${mic.id}`;
    if (mic.status === 'offline') continue;
    if (mic.status === 'missing') add({ id, status: 'fail', title: `${mic.name}'s mic is missing`, detail: mic.detail, fix: FIX.sound });
    else if (mic.detail) add({ id, status: 'warn', title: mic.name, detail: mic.detail, fix: FIX.sound });
    else if (!mic.live)
      add({ id, status: 'warn', title: `${mic.name} is not in the live scene`, detail: 'The stream cannot hear it. Click Add mics to all scenes.', fix: FIX.sound });
    else if (mic.muted) add({ id, status: 'warn', title: `${mic.name} is muted`, fix: FIX.sound });
    else ready++;
  }
  if (ready > 0) add({ id: 'mics', status: 'ok', title: `${plural(ready, 'mic')} ready` });
  if (audio.recordDetail) add({ id: 'record-tracks', status: 'warn', title: 'Recording tracks', detail: audio.recordDetail, fix: FIX.sound });
}

function headsetChecks(state: HeadsetsState, add: (c: Check) => void) {
  if (state.headsets.length === 0) return;
  if (state.plugin === false) {
    add({ id: 'headsets', status: 'warn', title: 'Headset mixes need the Audio Monitor plugin', detail: 'Install it in OBS, then restart OBS.', fix: FIX.sound });
    return;
  }
  let ready = 0;
  for (const h of state.headsets) {
    if (h.status === 'ok' && h.detail) add({ id: `headset-${h.id}`, status: 'warn', title: h.name, detail: h.detail, fix: FIX.sound });
    else if (h.status === 'ok') ready++;
  }
  if (ready > 0) add({ id: 'headsets', status: 'ok', title: `${plural(ready, 'headset')} ready` });
}

function recordingChecks(r: RecordingSession, add: (c: Check) => void) {
  const disk = diskWarning(r);
  if (r.disk) {
    if (disk) add({ id: 'disk', status: r.disk.level === 'critical' ? 'fail' : 'warn', title: disk, detail: r.disk.path });
    else add({ id: 'disk', status: 'ok', title: `${formatBytes(r.disk.freeBytes)} free for recording` });
  }
  if (r.detail) add({ id: 'recording', status: 'warn', title: 'Recording', detail: r.detail });
  if (r.cameras.some((c) => c.iso === 'no-plugin')) {
    add({ id: 'iso-plugin', status: 'warn', title: 'Camera files need the Source Record plugin', detail: 'The program recording still works.', fix: FIX.cameras });
  }
  for (const c of r.cameras) {
    if (c.iso === 'no-source' || c.iso === 'error') {
      add({ id: `iso-${c.id}`, status: 'warn', title: `${c.name} will not record its own file`, detail: c.detail ?? ISO_LABEL[c.iso], fix: FIX.cameras });
    }
  }
}

function cameraChecks(cameras: CameraState[], add: (c: Check) => void) {
  for (const cam of cameras) {
    const id = `camera-${cam.id}`;
    if (cam.obsDetail) add({ id, status: 'warn', title: cam.name, detail: cam.obsDetail, fix: FIX.cameras });
    else if (cam.driver && (cam.status === 'error' || cam.status === 'disconnected')) {
      add({ id, status: 'warn', title: `${cam.name} is ${cam.status === 'error' ? 'not working' : 'disconnected'}`, detail: cam.detail, fix: FIX.cameras });
    }
  }
}

export type PreflightSummary = { level: CheckStatus; fails: number; warns: number; label: string };

export function summarize(checks: Check[]): PreflightSummary {
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  if (fails > 0) return { level: 'fail', fails, warns, label: plural(fails, 'problem') };
  if (warns > 0) return { level: 'warn', fails, warns, label: `${warns} to check` };
  return { level: 'ok', fails, warns, label: 'All good' };
}
