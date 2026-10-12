import { useEffect, useRef, useState, type CSSProperties } from 'react';

/** Changes are sent at most this often while dragging, so a slider cannot flood OBS or a camera. */
export const RANGE_SEND_MS = 120;

export function ThrottledRange({
  id,
  label,
  value,
  min,
  max,
  step,
  disabled,
  format = (v) => String(v),
  onChange,
}: {
  id?: string;
  /** Accessible name when there is no visible <label for>. */
  label?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  const send = useRef(onChange);
  send.current = onChange;
  useEffect(() => () => clearTimeout(pending.current ?? undefined), []);
  // Show the dragged value until the hub answers, then follow the hub (it may have clamped the value).
  useEffect(() => {
    if (pending.current === null) setLocal(null);
  }, [value]);
  const change = (v: number) => {
    setLocal(v);
    latest.current = v;
    pending.current ??= setTimeout(() => {
      pending.current = null;
      send.current(latest.current);
    }, RANGE_SEND_MS);
  };
  const shown = local ?? value;
  // How far along the track the value sits, so CSS can fill the left side of the slider.
  const pct = max > min ? Math.min(100, Math.max(0, ((shown - min) / (max - min)) * 100)) : 0;
  return (
    <>
      <input
        id={id}
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, shown))}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
        style={{ '--range-pct': `${pct}%` } as CSSProperties}
      />
      <output htmlFor={id} className="small">
        {format(shown)}
      </output>
    </>
  );
}
