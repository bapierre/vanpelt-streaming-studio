type Props = {
  scenes: string[];
  current: string | null;
  disabled: boolean;
  onSelect: (scene: string) => void;
};

export function ScenePanel({ scenes, current, disabled, onSelect }: Props) {
  return (
    <section className="side-section">
      <h2>Scenes</h2>
      {scenes.length === 0 && <p className="side-empty">No scenes. Is OBS connected?</p>}
      <div className="scene-list">
        {scenes.map((scene) => (
          <button
            key={scene}
            className={scene === current ? 'scene active' : 'scene'}
            aria-pressed={scene === current}
            disabled={disabled}
            onClick={() => onSelect(scene)}
          >
            <span className="scene-name">{scene}</span>
            {scene === current && <span className="program-badge">Program</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
