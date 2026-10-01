type Props = {
  scenes: string[];
  current: string | null;
  disabled: boolean;
  onSelect: (scene: string) => void;
};

export function ScenePanel({ scenes, current, disabled, onSelect }: Props) {
  return (
    <section className="panel">
      <h2>Scenes</h2>
      {scenes.length === 0 && <p className="muted">No scenes. Is OBS connected?</p>}
      <div className="scene-grid">
        {scenes.map((scene) => (
          <button
            key={scene}
            className={scene === current ? 'scene active' : 'scene'}
            aria-pressed={scene === current}
            disabled={disabled}
            onClick={() => onSelect(scene)}
          >
            {scene}
          </button>
        ))}
      </div>
    </section>
  );
}
