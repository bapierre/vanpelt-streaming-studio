import type { EventPayload } from '@streamhub/shared';
import { Panel } from './ui';

type Props = {
  sources: EventPayload<'obs.sources.list'> | null;
  disabled: boolean;
  onToggle: (scene: string, source: string, visible: boolean) => void;
};

/** The sources of the current scene with show/hide switches. */
export function SourcesPanel({ sources, disabled, onToggle }: Props) {
  return (
    <Panel title={sources ? `In ${sources.scene}` : 'Sources'} sub={sources ? 'Show or hide' : undefined}>
      {(!sources || sources.sources.length === 0) && <p className="panel-empty">No sources in this scene.</p>}
      <ul className="src-rows">
        {sources?.sources.map((s) => (
          <li key={s.name} className={s.visible ? 'src' : 'src off'}>
            <span className="src-name">{s.name}</span>
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
    </Panel>
  );
}
