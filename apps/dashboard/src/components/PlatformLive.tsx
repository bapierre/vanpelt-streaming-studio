import type { PlatformLive } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { PlatformLogo } from './ui';

const BROADCAST: Record<PlatformLive['broadcast'], string> = {
  none: 'No broadcast',
  scheduled: 'Ready, not started',
  running: 'Live',
  ended: 'Ended',
};

const INGEST: Record<PlatformLive['ingest'], string> = {
  active: 'Receiving video',
  inactive: 'No video received',
  unknown: 'Video signal unknown',
};

const viewerCount = new Intl.NumberFormat(undefined, { notation: 'compact' });

export function describeLive(live: PlatformLive): string {
  const parts = [BROADCAST[live.broadcast]];
  if (live.broadcast === 'running' && live.viewers !== undefined) parts.push(`${viewerCount.format(live.viewers)} watching`);
  return parts.join(' · ');
}

/** Toolbar pill: what the platform itself says about the stream, next to OBS's own on-air state. */
export function PlatformLiveBadge({ live }: { live: PlatformLive }) {
  const { label } = PLATFORMS[live.platform];
  const title = [`${label}: ${describeLive(live)}`, INGEST[live.ingest], live.title, live.detail].filter(Boolean).join('\n');
  const short =
    live.broadcast === 'running'
      ? live.viewers !== undefined
        ? viewerCount.format(live.viewers)
        : 'Live'
      : BROADCAST[live.broadcast];
  return (
    <span className={`live-badge ${live.broadcast}`} title={title} data-testid={`live-${live.platform}`}>
      <PlatformLogo platform={live.platform} size={20} />
      <span className={`ingest-dot ${live.ingest}`} aria-label={INGEST[live.ingest]} />
      <span>
        {short}
        <span className="sr-only">{live.broadcast === 'running' && live.viewers !== undefined ? ' watching' : ''}</span>
      </span>
    </span>
  );
}

/** Settings row detail: the same state spelled out. */
export function PlatformLiveDetail({ live }: { live: PlatformLive }) {
  return (
    <dl className="live-detail">
      <dt>Broadcast</dt>
      <dd>{describeLive(live)}</dd>
      <dt>Video</dt>
      <dd>
        <span className={`ingest-dot ${live.ingest}`} aria-hidden /> {INGEST[live.ingest]}
      </dd>
      {live.title && (
        <>
          <dt>Title</dt>
          <dd>{live.title}</dd>
        </>
      )}
      {live.detail && (
        <>
          <dt>Note</dt>
          <dd className="muted">{live.detail}</dd>
        </>
      )}
    </dl>
  );
}
