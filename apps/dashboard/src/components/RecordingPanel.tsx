import type { RecordingSession } from '@streamhub/shared';
import { CARD_LABEL, diskWarning, fileName, formatBytes, ISO_LABEL } from '../recording';

const good = (s: string | undefined) => s === 'ready' || s === 'recording';

/** What each camera will record, how much disk is left, and what the last take saved. */
export function RecordingPanel({ recording }: { recording: RecordingSession | null }) {
  if (!recording) return null;
  const warning = diskWarning(recording);
  const files = recording.lastSession?.files ?? [];
  return (
    <section className="side-section recording-panel">
      <h2>Recording</h2>
      {recording.detail && <p className="rec-detail">{recording.detail}</p>}
      {warning ? (
        <p className={`rec-disk ${recording.disk?.level}`} role="alert">{warning}</p>
      ) : (
        recording.disk && <p className="rec-disk">{formatBytes(recording.disk.freeBytes)} free</p>
      )}
      {recording.cameras.length === 0 && <p className="side-empty">No cameras in cameras.json.</p>}
      <ul className="rec-cameras">
        {recording.cameras.map((c) => (
          <li key={c.id}>
            <span className="rec-cam-name">{c.name}</span>
            {c.mode === 'off' && <span className="muted">not recorded</span>}
            {c.iso && (
              <span className={good(c.iso) ? 'rec-status ok' : 'rec-status bad'}>
                <span className="dot" /> file: {ISO_LABEL[c.iso]}
              </span>
            )}
            {c.card && (
              <span className={good(c.card) ? 'rec-status ok' : 'rec-status bad'}>
                <span className="dot" /> card: {CARD_LABEL[c.card]}
              </span>
            )}
            {c.detail && <span className="rec-cam-detail">{c.detail}</span>}
          </li>
        ))}
      </ul>
      {recording.lastSession && (
        <>
          <h3 className="rec-files-title">Saved last take</h3>
          {files.length === 0 && <p className="side-empty">No files were found.</p>}
          <ul className="rec-files">
            {files.map((f) => (
              <li key={`${f.kind}:${f.location}`} title={f.location}>
                <span className="rec-file-label">{f.label}</span>
                <span className="rec-file-path">{f.kind === 'card' ? f.location : fileName(f.location)}</span>
              </li>
            ))}
          </ul>
          {recording.directory && files.some((f) => f.kind !== 'card') && (
            <p className="muted rec-dir" title={recording.directory}>in {recording.directory}</p>
          )}
        </>
      )}
    </section>
  );
}
