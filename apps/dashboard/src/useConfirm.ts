import { useEffect, useRef, useState } from 'react';

export type ConfirmOptions = {
  /** How long the armed state lasts. */
  confirmMs?: number;
  /** Confirming clicks faster than this are ignored, so a double-click never fires. */
  minConfirmMs?: number;
  /** Disarm whenever this changes, e.g. when what the action would do flips underneath. */
  resetKey?: unknown;
};

/** A two-click guard: the first click arms, a second click within the window runs the action. */
export function useConfirm({ confirmMs = 4000, minConfirmMs = 500, resetKey }: ConfirmOptions = {}) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), confirmMs);
    return () => clearTimeout(t);
  }, [armed, confirmMs]);

  useEffect(() => {
    setArmed(false);
  }, [resetKey]);

  const click = (action: () => void) => {
    if (!armed) {
      armedAt.current = Date.now();
      setArmed(true);
      return;
    }
    if (Date.now() - armedAt.current < minConfirmMs) return;
    setArmed(false);
    action();
  };

  return { armed, click };
}
