import type { CameraRecording, RecordingSession } from '@streamhub/shared';
import { formatMinutes, diskWarning, fileName, formatBytes, ISO_LABEL, CARD_LABEL, isRecording } from '../recording';
import { formatUptime } from '../state';
import { useNow } from '../useNow';
import { Panel, Pill } from './ui';

const good = (s: string | undefined) => s === 'ready' || s === 'recording';

/** The row's dot: green when everything it records works, orange when something needs attention. */
function rowDot(c: CameraRecording): string {
  if (c.mode === 'off') return 'dot';
  const states: string[] = [];
  if (c.iso !== undefined) states.push(c.iso);
  if (c.card !== undefined) states.push(c.card);
  if (states.length === 0) return 'dot';
  return states.every(good) ? 'dot ok' : 'dot warn';
}

/** What each camera records, how long the take runs, and how much disk is left. */
export function RecordingPanel({ recording }: { recording: RecordingSession | null }) {
  const now = useNow(1000);
  if (!recording) return null;
  const warning = diskWarning(recording);
  const files = recording.lastSession?.files ?? [];
  const take =
    isRecording(recording) && recording.startedAt !== undefined ? (
      <Pill tone="live">REC {formatUptime(now - recording.startedAt)}</Pill>
    ) : recording.output === 'paused' ? (
      <Pill tone="warn">Paused</Pill>
    ) : undefined;
  return (
    <Panel className="recording" title="Recording" actions={take}>
      {recording.detail && <p className="rec-detail">{recording.detail}</p>}
      {recording.cameras.length === 0 && <p className="panel-empty">No cameras in cameras.json.</p>}
      <ul className="rec-rows">
        {recording.cameras.map((c) => (
          <li key={c.id} className="rec-row">
            <span className={rowDot(c)} aria-hidden />
            <span className="rec-cam-name">{c.name}</span>
            {c.mode === 'off' && <span className="muted">not recorded</span>}
            {c.iso && (
              <span className={good(c.iso) ? 'rec-status ok' : 'rec-status bad'}>
                <span className="dot" aria-hidden /> file: {ISO_LABEL[c.iso]}
              </span>
            )}
            {c.card && (
              <span className={good(c.card) ? 'rec-status ok' : 'rec-status bad'}>
                <span className="dot" aria-hidden /> card: {CARD_LABEL[c.card]}
              </span>
            )}
            {c.detail && <span className="rec-cam-detail">{c.detail}</span>}
          </li>
        ))}
      </ul>
      {warning ? (
        <p className={`rec-disk ${recording.disk?.level ?? ''}`} role="alert">
          {warning}
        </p>
      ) : (
        recording.disk && (
          <p className="rec-disk">
            {formatBytes(recording.disk.freeBytes)} free
            {recording.disk.minutesLeft !== undefined && `, about ${formatMinutes(recording.disk.minutesLeft)} left`}
          </p>
        )
      )}
      {recording.lastSession && (
        <div className="rec-last">
          <h3>Saved last take</h3>
          {files.length === 0 && <p className="panel-empty">No files were found.</p>}
          <ul className="rec-rows">
            {files.map((f) => (
              <li key={`${f.kind}:${f.location}`} className="rec-row" title={f.location}>
                <span className="rec-file-label">{f.label}</span>
                <span className="rec-file-path">{f.kind === 'card' ? f.location : fileName(f.location)}</span>
              </li>
            ))}
          </ul>
          {recording.directory && files.some((f) => f.kind !== 'card') && (
            <p className="rec-dir">in {recording.directory}</p>
          )}
        </div>
      )}
    </Panel>
  );
}
