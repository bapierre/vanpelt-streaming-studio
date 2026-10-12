import { useState, type ReactNode } from 'react';
import type { Platform, StreamDestination } from '@streamhub/shared';
import { CamerasPanel } from '../components/CamerasPanel';
import { needsAttention, type ConnectionActions } from '../components/ConnectionsPanel';
import { DestinationsPanel, type StreamKeyActions } from '../components/DestinationsPanel';
import { ObsSettings } from '../components/Obs';
import { PlatformPage } from '../components/settings/PlatformPage';
import { PreferencesPage } from '../components/settings/PreferencesPage';
import { doneCount, SetupOverview, setupSteps } from '../components/settings/SetupOverview';
import { PageHead, PlatformLogo, SideNav, type NavPage } from '../components/ui';
import { PLATFORMS } from '../platforms';
import type { Prefs } from '../prefs';
import type { Studio } from '../useStudio';

/** Sidebar order: get started, then connections, the studio, the app itself. */
const CONNECTIONS: Platform[] = ['twitch', 'youtube', 'kick', 'x'];

const PAGE_LABELS: Record<string, string> = {
  overview: 'Setup overview',
  obs: 'OBS',
  other: 'Other destinations',
  cameras: 'Cameras',
  mics: 'Mics and headsets',
  preferences: 'Preferences',
  ...Object.fromEntries(CONNECTIONS.map((p) => [p, PLATFORMS[p].label])),
};

/** Page ids that survive from the old flat Settings, so old links keep landing somewhere useful. */
const LEGACY_PAGES: Record<string, string> = { general: 'preferences', destinations: 'twitch', platforms: 'twitch' };

const validPage = (id: string | undefined, fallback: string) => {
  if (id && (id in PAGE_LABELS)) return id;
  if (id && (id in LEGACY_PAGES)) return LEGACY_PAGES[id]!;
  return fallback;
};

/** A dark neutral tile: OBS is gear, not a platform. */
const ObsLogo = () => (
  <span className="platform-logo obs" role="img" aria-label="OBS">
    <span className="obs-mark">OBS</span>
  </span>
);

/** One-time setup: connections, gear and app preferences, one page at a time. */
export function SettingsArea({
  studio,
  initial,
  prefs,
  onPrefs,
}: {
  studio: Studio;
  /** A pre-flight fix or the banner can name the page to open. */
  initial?: string;
  prefs: Prefs;
  onPrefs: (change: Partial<Prefs>) => void;
}) {
  const { client, state, audio, cameras, obsReady } = studio;
  const [page, setPage] = useState(validPage(initial, 'overview'));
  const live = state.stream.state !== 'stopped';
  const steps = setupSteps(state, audio.state);

  const connectionActions = (platform: Platform): ConnectionActions => ({
    onConnect: () => client.publish('connections.cmd.connect', { platform }),
    onDisconnect: () => client.publish('connections.cmd.disconnect', { platform }),
    onSetTwitchClient: (clientId) => client.publish('connections.cmd.setTwitchClient', { clientId }),
    onSetYoutubeClient: (clientId, clientSecret) => client.publish('connections.cmd.setYoutubeClient', { clientId, clientSecret }),
    onSetXClient: (clientId) => client.publish('connections.cmd.setXClient', { clientId }),
  });
  const streamKeyActions: StreamKeyActions = {
    onSave: (d) => client.publish('destinations.cmd.save', d),
    onRemove: (id) => client.publish('destinations.cmd.remove', { id }),
    onUseInObs: (id) => client.publish('destinations.cmd.useInObs', { id }),
  };
  const destinations: StreamDestination[] = state.destinations.destinations;

  const pages: NavPage[] = [
    { id: 'overview', label: 'Setup overview', group: 'Get started', note: `${doneCount(steps)} of ${steps.length}` },
    { id: 'obs', label: 'OBS', group: 'Connections', icon: <ObsLogo />, attention: !state.obs.connected },
    ...CONNECTIONS.map((p) => ({
      id: p,
      label: PLATFORMS[p].label,
      group: 'Connections',
      icon: <PlatformLogo platform={p} size={22} />,
      attention: needsAttention(state.connections[p]),
    })),
    { id: 'other', label: 'Other destinations', group: 'Connections' },
    { id: 'cameras', label: 'Cameras', group: 'Studio' },
    { id: 'mics', label: 'Mics and headsets', group: 'Studio' },
    { id: 'preferences', label: 'Preferences', group: 'App' },
  ];

  const body = (): ReactNode => {
    if (page === 'overview')
      return (
        <SetupOverview
          state={state}
          audio={audio.state}
          modules={studio.alerts.modules}
          onOpen={(id) => setPage(validPage(id, 'overview'))}
        />
      );
    if (page === 'obs')
      return (
        <ObsSettings
          obs={state.obs}
          settings={state.obsSettings}
          onSave={(url, password) =>
            client.publish('connections.cmd.setObs', password === undefined ? { url } : { url, password })
          }
          onReconnect={() => client.publish('obs.cmd.reconnect')}
          onRefresh={() => client.publish('obs.cmd.refresh')}
        />
      );
    if (page === 'cameras')
      return (
        <>
          <PageHead title="Cameras">
            Each camera has its own OBS scene. Take switches OBS to that scene, and the controls come from the camera's
            driver.
          </PageHead>
          <CamerasPanel
            cameras={cameras}
            disabled={!state.hubConnected}
            onTake={studio.takeCamera}
            onSet={(id, key, value) => client.publish('camera.cmd.set', { id, key, value })}
          />
        </>
      );
    if (page === 'mics')
      return (
        <>
          <PageHead title="Mics and headsets">Mics and headphones are set up in the Sound tab (⌘2).</PageHead>
          <p className="muted">
            The sound check, the mixer and every headset mix live there. The sound check target is in Preferences below.
          </p>
        </>
      );
    if (page === 'preferences')
      return (
        <>
          <PageHead title="Preferences">The sound check target, and how this dashboard behaves.</PageHead>
          <PreferencesPage
            targetDb={audio.state?.targetDb ?? null}
            disabled={!state.hubConnected}
            prefs={prefs}
            onTarget={studio.audioActions.onTarget}
            onPrefs={onPrefs}
          />
        </>
      );
    if (page === 'other')
      return (
        <>
          <PageHead title="Other destinations">Custom RTMP targets that belong to no platform.</PageHead>
          <DestinationsPanel
            destinations={destinations}
            inObs={state.destinations.inObs}
            obsReady={obsReady}
            live={live}
            actions={streamKeyActions}
          />
        </>
      );
    if ((CONNECTIONS as string[]).includes(page))
      return (
        <PlatformPage
          platform={page as Platform}
          state={state}
          destinations={destinations}
          obsReady={obsReady}
          live={live}
          connectionActions={connectionActions(page as Platform)}
          streamKeyActions={streamKeyActions}
        />
      );
    return null;
  };

  return (
    <div className="split">
      <SideNav pages={pages} current={page} label="Settings pages" onSelect={setPage} />
      <section className="split-body" aria-label={PAGE_LABELS[page]}>
        <div className="split-inner">{body()}</div>
      </section>
    </div>
  );
}
