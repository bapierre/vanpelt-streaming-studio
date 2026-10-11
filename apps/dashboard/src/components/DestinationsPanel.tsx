import { useEffect, useState, type FormEvent } from 'react';
import type { StreamDestination } from '@streamhub/shared';
import type { DashboardState } from '../state';
import { Icon } from './Icon';
import { SecretInput } from './Secret';

const PRESETS = [
  { id: 'twitch', label: 'Twitch', where: 'Twitch dashboard → Settings → Stream → Primary stream key' },
  { id: 'youtube', label: 'YouTube', where: 'YouTube Studio → Go live → Stream: Stream URL + Stream key' },
  { id: 'kick', label: 'Kick', where: 'Kick dashboard → Settings → Stream URL & Key' },
  { id: 'x', label: 'X', where: 'studio.x.com → Producer → Sources → your RTMP source' },
];

type Props = {
  list: DashboardState['destinations'];
  obsReady: boolean;
  live: boolean;
  onSave: (d: StreamDestination) => void;
  onRemove: (id: string) => void;
  onUseInObs: (id: string) => void;
};

function Destination({
  preset,
  saved,
  inObs,
  canUseInObs,
  onSave,
  onRemove,
  onUseInObs,
}: {
  preset: (typeof PRESETS)[number];
  saved: StreamDestination | undefined;
  inObs: boolean;
  canUseInObs: boolean;
  onSave: (d: StreamDestination) => void;
  onRemove: () => void;
  onUseInObs: () => void;
}) {
  const [server, setServer] = useState(saved?.server ?? '');
  const [key, setKey] = useState(saved?.key ?? '');
  useEffect(() => {
    setServer(saved?.server ?? '');
    setKey(saved?.key ?? '');
  }, [saved?.server, saved?.key]);

  const valid = /^rtmps?:\/\/\S+$/.test(server.trim());
  const dirty = server !== (saved?.server ?? '') || key !== (saved?.key ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSave({ id: preset.id, label: preset.label, server: server.trim(), key: key.trim() });
  };

  return (
    <form className="group-row form destination" data-testid={`dest-${preset.id}`} onSubmit={submit}>
      <div className="destination-head">
        <strong>{preset.label}</strong>
        {inObs && <span className="badge">In OBS</span>}
        <span className="spacer" />
        {saved && (
          <>
            <button type="button" className="icon-button" aria-label={`Copy ${preset.label} stream key`} title="Copy stream key" onClick={() => void navigator.clipboard?.writeText(saved.key)}>
              <Icon name="copy" />
            </button>
            <button type="button" disabled={!canUseInObs || inObs} onClick={onUseInObs}>
              Use in OBS
            </button>
          </>
        )}
      </div>
      <p className="muted small">{preset.where}</p>
      <SecretInput label="Server URL" value={server} onChange={(e) => setServer(e.target.value)} placeholder="rtmp://…" autoComplete="off" />
      <SecretInput label="Stream key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      <div className="form-actions">
        {saved && (
          <button type="button" className="link" onClick={onRemove}>
            Remove
          </button>
        )}
        <button type="submit" disabled={!valid || !dirty}>
          Save
        </button>
      </div>
    </form>
  );
}

export function DestinationsPanel({ list, obsReady, live, onSave, onRemove, onUseInObs }: Props) {
  const byId = new Map(list.destinations.map((d) => [d.id, d]));
  return (
    <>
      <p className="muted small">
        OBS does the streaming. “Use in OBS” writes a destination into OBS’s main stream output (not while live). For
        the other platforms, copy the server and key into OBS → Docks → Multiple output, and tick “Sync start/stop with
        OBS” so Go Live starts them too.
      </p>
      {list.detail && <p className="conn-error">{list.detail}</p>}
      <section className="group">
        {PRESETS.map((p) => (
          <Destination
            key={p.id}
            preset={p}
            saved={byId.get(p.id)}
            inObs={list.inObs === p.id}
            canUseInObs={obsReady && !live}
            onSave={onSave}
            onRemove={() => onRemove(p.id)}
            onUseInObs={() => onUseInObs(p.id)}
          />
        ))}
      </section>
    </>
  );
}
