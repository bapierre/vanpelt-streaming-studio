import type { EventPayload } from '@streamhub/shared';

type Props = {
  sources: EventPayload<'obs.sources.list'> | null;
  disabled: boolean;
  onToggle: (scene: string, source: string, visible: boolean) => void;
};

export function SourcesPanel({ sources, disabled, onToggle }: Props) {
  return (
    <section className="side-section">
      <h2>Sources{sources && <span className="side-sub"> in {sources.scene}</span>}</h2>
      {(!sources || sources.sources.length === 0) && <p className="side-empty">No sources in this scene.</p>}
      <ul className="source-list">
        {sources?.sources.map((s) => (
          <li key={s.name} className={s.visible ? 'source' : 'source hidden'}>
            <span className="source-name">{s.name}</span>
            <button
              role="switch"
              className="switch"
              aria-checked={s.visible}
              aria-label={`Show ${s.name}`}
              disabled={disabled}
              onClick={() => onToggle(sources.scene, s.name, !s.visible)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
