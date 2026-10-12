import { useEffect } from 'react';
import { useSceneImage, type PreviewsStore } from '../usePreviews';
import { Panel } from './ui';

type Props = {
  scenes: string[];
  current: string | null;
  disabled: boolean;
  /** Newest thumbnail per scene, from the hub's preview lease. */
  previews: PreviewsStore;
  /** Whether tiles show thumbnails; a preference, kept in previewPrefs. */
  previewsOn: boolean;
  onTogglePreviews: (on: boolean) => void;
  onSelect: (scene: string) => void;
};

/** Digits 1–9 cut to a scene, but never while typing. ⌘1–4 switch tabs and must keep working. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  );
}

export function ScenePanel({
  scenes,
  current,
  disabled,
  previews,
  previewsOn,
  onTogglePreviews,
  onSelect,
}: Props) {
  // Live while the Live tab is shown (this panel only mounts there). Bare digits cut; modifiers are
  // left to the tab switcher and anything else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTyping(e.target)) return;
      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index > 8) return;
      const scene = scenes[index];
      if (!scene || disabled) return;
      e.preventDefault();
      onSelect(scene);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scenes, disabled, onSelect]);

  return (
    <Panel
      title="Scenes"
      sub="Click to cut"
      actions={
        <span className="preview-toggle">
          <span className="preview-toggle-label">Previews</span>
          <button
            role="switch"
            className="switch"
            aria-checked={previewsOn}
            aria-label="Scene previews"
            title="Show a live thumbnail of each scene. Off saves GPU in OBS."
            onClick={() => onTogglePreviews(!previewsOn)}
          />
        </span>
      }
    >
      {scenes.length === 0 && <p className="panel-empty">No scenes. Is OBS connected?</p>}
      <div className="scene-grid">
        {scenes.map((scene, i) => (
          <SceneTile
            key={scene}
            scene={scene}
            hint={i < 9 ? String(i + 1) : undefined}
            onAir={scene === current}
            disabled={disabled}
            previews={previews}
            previewsOn={previewsOn}
            onSelect={onSelect}
          />
        ))}
      </div>
    </Panel>
  );
}

function SceneTile({
  scene,
  hint,
  onAir,
  disabled,
  previews,
  previewsOn,
  onSelect,
}: {
  scene: string;
  hint: string | undefined;
  onAir: boolean;
  disabled: boolean;
  previews: PreviewsStore;
  previewsOn: boolean;
  onSelect: (scene: string) => void;
}) {
  const image = useSceneImage(previews, scene);
  const show = previewsOn && image;
  return (
    <button
      className={onAir ? 'scene-tile program' : 'scene-tile'}
      aria-label={scene}
      aria-pressed={onAir}
      disabled={disabled}
      title={hint ? `${scene} (press ${hint})` : scene}
      onClick={() => onSelect(scene)}
    >
      {show && <img className="scene-img" src={image} alt="" />}
      {show && <span className="scene-img-shade" aria-hidden />}
      {onAir && <span className="on-air-tag">On air</span>}
      {hint && (
        <span className="scene-key" aria-hidden>
          {hint}
        </span>
      )}
      <span className="scene-name">{scene}</span>
    </button>
  );
}
