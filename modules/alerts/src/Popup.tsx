import { useEffect, useRef, useState } from 'react';
import type { AlertKind, AlertShow } from '@streamhub/shared';
import type { HubClient } from '@streamhub/overlay-sdk';
import { playSound as defaultPlaySound } from './sounds';

/** Matches the leave animation in styles.css. */
export const LEAVE_MS = 450;
/** If the hub's alert.hide never arrives (hub restarted mid-alert), the pop-up still goes away. */
const SAFETY_MS = 2000;

export const KIND_LABELS: Record<AlertKind, string> = {
  follow: 'New follower',
  sub: 'New subscriber',
  resub: 'Resub',
  giftsub: 'Gift subs',
  cheer: 'Cheer',
  tip: 'Tip',
  raid: 'Raid',
};

type Props = {
  hub: Pick<HubClient, 'on'>;
  playSound?: typeof defaultPlaySound;
};

export function Popup({ hub, playSound = defaultPlaySound }: Props) {
  const [shown, setShown] = useState<AlertShow | null>(null);
  const [leaving, setLeaving] = useState(false);
  const currentId = useRef<string | null>(null);
  const timers = useRef<{
    safety?: ReturnType<typeof setTimeout>;
    leave?: ReturnType<typeof setTimeout>;
  }>({});
  const sound = useRef(playSound);
  sound.current = playSound;

  useEffect(() => {
    const t = timers.current;
    const leave = (id: string) => {
      if (currentId.current !== id) return;
      clearTimeout(t.safety);
      setLeaving(true);
      t.leave = setTimeout(() => {
        if (currentId.current !== id) return;
        currentId.current = null;
        setShown(null);
        setLeaving(false);
      }, LEAVE_MS);
    };
    const offShow = hub.on('alert.show', (e) => {
      const next = e.payload as AlertShow;
      clearTimeout(t.safety);
      clearTimeout(t.leave);
      currentId.current = next.alert.id;
      setShown(next);
      setLeaving(false);
      sound.current(next.sound, next.volume);
      t.safety = setTimeout(() => leave(next.alert.id), next.durationMs + SAFETY_MS);
    });
    const offHide = hub.on('alert.hide', (e) => leave((e.payload as { id: string }).id));
    return () => {
      offShow();
      offHide();
      clearTimeout(t.safety);
      clearTimeout(t.leave);
    };
  }, [hub]);

  if (!shown) return null;
  const { alert, text } = shown;
  return (
    <div className="stage popup-stage">
      <div
        key={alert.id}
        className={`popup kind-${alert.kind} platform-${alert.platform}${leaving ? ' leaving' : ''}`}
        role="status"
        aria-live="polite"
      >
        <div className="avatar" aria-hidden="true">
          {alert.user.avatarUrl ? (
            <img src={alert.user.avatarUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span>{(alert.user.name.trim()[0] ?? '?').toUpperCase()}</span>
          )}
        </div>
        <div className="popup-body">
          <div className="popup-kind">{KIND_LABELS[alert.kind]}</div>
          <div className="popup-text">{text}</div>
          {alert.message ? <div className="popup-message">{alert.message}</div> : null}
        </div>
      </div>
    </div>
  );
}
