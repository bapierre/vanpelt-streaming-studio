import { useEffect, useState, type FormEvent } from 'react';
import type { Platform, StreamDestination } from '@streamhub/shared';
import { PLATFORMS } from '../platforms';
import { Icon } from './Icon';
import { SecretInput, SecretText } from './Secret';
import { Panel, Pill, PlatformLogo } from './ui';

/** Where each platform hides its stream key, the one hint every streamer needs. */
const WHERE: Record<Platform, string> = {
  twitch: 'Twitch dashboard → Settings → Stream → Primary stream key',
  youtube: 'YouTube Studio → Go live → Stream: Stream URL + Stream key',
  kick: 'Kick dashboard → Settings → Stream URL & Key',
  x: 'studio.x.com → Producer → Sources → your RTMP source',
};

const PLATFORM_IDS = new Set<string>(Object.keys(PLATFORMS));
/** True when a saved destination belongs to no known platform (custom RTMP). */
export const isCustomDestination = (d: StreamDestination) => !PLATFORM_IDS.has(d.id);

export type StreamKeyActions = {
  onSave: (destination: StreamDestination) => void;
  onRemove: (id: string) => void;
  onUseInObs: (id: string) => void;
};

/** "Stream key" card: one platform's destination, or a custom one on the Other destinations page. */
export function StreamKeyCard({
  platform,
  destination,
  inObs,
  canUseInObs,
  actions,
}: {
  /** Omitted for custom destinations. */
  platform?: Platform;
  destination: StreamDestination | undefined;
  /** OBS's main stream output uses exactly this destination. */
  inObs: boolean;
  /** OBS is up and the show is not live, so "Use in OBS" may run. */
  canUseInObs: boolean;
  actions: StreamKeyActions;
}) {
  const [editing, setEditing] = useState(false);
  const hint = platform ? WHERE[platform] : undefined;
  const name = (platform ? PLATFORMS[platform].label : destination?.label) ?? 'Stream key';
  return (
    <Panel
      className="stream-key-card"
      title={
        <span className="card-title">
          {platform && <PlatformLogo platform={platform} size={28} />}
          Stream key
        </span>
      }
      sub="Where OBS sends your video"
      label={`${name}: Stream key`}
      actions={
        <Pill tone={inObs ? 'ok' : 'off'} dot>
          {inObs ? 'In OBS' : destination ? 'Saved' : 'Not saved'}
        </Pill>
      }
    >
      <div className="card-body">
        <p className="muted small">
          OBS does the streaming. Use in OBS writes this into OBS's main stream output (not while live).{' '}
          {hint && <>Get it from {hint}.</>}
        </p>
        {destination ? (
          <>
            <div className="key-rows">
              <div className="key-row">
                <span className="key-k">Server</span>
                <code className="key-v">{destination.server}</code>
              </div>
              <div className="key-row">
                <span className="key-k">Stream key</span>
                <SecretText value={destination.key} label={`${name} stream key`} />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Copy ${name} stream key`}
                  title="Copy stream key"
                  onClick={() => void navigator.clipboard?.writeText(destination.key)}
                >
                  <Icon name="copy" />
                </button>
              </div>
              {inObs && (
                <div className="key-row">
                  <span className="key-k">In OBS</span>
                  <span className="key-v muted">OBS streams to {name} as its main output</span>
                </div>
              )}
            </div>
            <div className="card-actions">
              <button disabled={!canUseInObs || inObs} onClick={() => actions.onUseInObs(destination.id)}>
                Use in OBS
              </button>
              <button className="ghost" onClick={() => setEditing((e) => !e)}>
                {editing ? 'Close' : 'Edit'}
              </button>
              <button className="link" onClick={() => actions.onRemove(destination.id)}>
                Remove
              </button>
            </div>
            {editing && (
              <DestinationForm
                initial={destination}
                fixedId={{ id: destination.id, label: destination.label }}
                onSave={(d) => {
                  actions.onSave(d);
                  setEditing(false);
                }}
              />
            )}
          </>
        ) : (
          <DestinationForm
            fixedId={platform ? { id: platform, label: PLATFORMS[platform].label } : undefined}
            onSave={actions.onSave}
          />
        )}
      </div>
    </Panel>
  );
}

function DestinationForm({
  initial,
  fixedId,
  taken = [],
  submitLabel = 'Save',
  onSave,
}: {
  initial?: StreamDestination;
  /** Platform pages pin the id and label; the Other page derives them from what the user types. */
  fixedId?: { id: string; label?: string };
  /** Ids already in use, so a new custom destination cannot shadow one of them. */
  taken?: string[];
  submitLabel?: string;
  onSave: (d: StreamDestination) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [server, setServer] = useState(initial?.server ?? '');
  const [key, setKey] = useState(initial?.key ?? '');
  useEffect(() => {
    setLabel(initial?.label ?? '');
    setServer(initial?.server ?? '');
    setKey(initial?.key ?? '');
  }, [initial?.label, initial?.server, initial?.key]);

  const valid = /^rtmps?:\/\/\S+$/.test(server.trim()) && (fixedId || label.trim().length > 0);
  const dirty = !initial || server !== initial.server || key !== initial.key || (!fixedId && label !== initial.label);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSave({
      id: fixedId?.id ?? uniqueId(slug(label.trim()), taken),
      label: fixedId?.label ?? label.trim(),
      server: server.trim(),
      key: key.trim(),
    });
    if (!initial) {
      setLabel('');
      setServer('');
      setKey('');
    }
  };
  return (
    <form className="destination-form" onSubmit={submit}>
      {!fixedId && (
        <label className="field">
          <span className="field-label">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Where this goes" />
        </label>
      )}
      <SecretInput label="Server URL" value={server} onChange={(e) => setServer(e.target.value)} placeholder="rtmp://…" autoComplete="off" />
      <SecretInput label="Stream key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      <div className="form-actions">
        <button type="submit" disabled={!valid || !dirty}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A slug the hub accepts as a destination id: [a-z0-9-]. */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'custom';

/** Labels collide ("My server" twice), so append 2, 3… until the id is free. */
function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const next = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.includes(next)) return next;
  }
}

/** Custom RTMP targets that belong to no platform: restream services, private servers, one-off events. */
export function DestinationsPanel({
  destinations,
  inObs,
  obsReady,
  live,
  actions,
}: {
  destinations: StreamDestination[];
  /** The destination id OBS's main stream output uses. */
  inObs: string | null;
  obsReady: boolean;
  live: boolean;
  actions: StreamKeyActions;
}) {
  const custom = destinations.filter(isCustomDestination);
  return (
    <>
      <p className="muted small">
        Destinations that belong to no platform: a restream service, a private server, a one-off event. OBS still does
        the streaming. For several platforms at once, see <code>docs/multistream.md</code>.
      </p>
      {custom.map((d) => (
        <StreamKeyCard key={d.id} destination={d} inObs={inObs === d.id} canUseInObs={obsReady && !live} actions={actions} />
      ))}
      {custom.length === 0 && <p className="muted">No other destinations yet.</p>}
      <section className="group add-destination" aria-label="Add a destination">
        <strong>Add a destination</strong>
        <DestinationForm taken={destinations.map((d) => d.id)} submitLabel="Add" onSave={actions.onSave} />
      </section>
    </>
  );
}
