import type { Platform, StreamDestination } from '@streamhub/shared';
import { PLATFORMS } from '../../platforms';
import type { DashboardState } from '../../state';
import { ConnectionCard, type ConnectionActions } from '../ConnectionsPanel';
import { StreamKeyCard, type StreamKeyActions } from '../DestinationsPanel';
import { PageHead } from '../ui';

const PAGE_SUB: Record<Platform, string> = {
  twitch: 'Chat and alerts come from your Twitch account. The stream key lets OBS send your video to Twitch.',
  youtube: 'Chat and alerts come from your YouTube account. The stream key lets OBS send your video to YouTube.',
  kick: 'Kick chat arrives with the relay (M3). The stream key works today.',
  x: 'X only reports whether your livestream is running and who is watching. X chat is not pulled in. The stream key lets OBS send your video to X.',
};

/** One platform's Settings page: its connection card on top, its stream key below. */
export function PlatformPage({
  platform,
  state,
  destinations,
  obsReady,
  live,
  connectionActions,
  streamKeyActions,
}: {
  platform: Platform;
  state: DashboardState;
  destinations: StreamDestination[];
  obsReady: boolean;
  /** The show is on air; OBS's stream output must not be touched. */
  live: boolean;
  connectionActions: ConnectionActions;
  streamKeyActions: StreamKeyActions;
}) {
  const connection = state.connections[platform];
  const destination = destinations.find((d) => d.id === platform);
  return (
    <>
      <PageHead title={PLATFORMS[platform].label}>{PAGE_SUB[platform]}</PageHead>
      <ConnectionCard
        platform={platform}
        state={connection}
        live={state.live[platform]}
        actions={connectionActions}
      />
      <StreamKeyCard
        platform={platform}
        destination={destination}
        inObs={state.destinations.inObs === platform}
        canUseInObs={obsReady && !live}
        actions={streamKeyActions}
      />
    </>
  );
}
