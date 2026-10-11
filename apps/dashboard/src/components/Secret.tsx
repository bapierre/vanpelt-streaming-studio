import { useState, type InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

function RevealButton({ shown, label, onToggle }: { shown: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" className="icon-button" aria-label={`${shown ? 'Hide' : 'Reveal'} ${label}`} onClick={onToggle}>
      <Icon name={shown ? 'eyeOff' : 'eye'} />
    </button>
  );
}

/** Masked until the streamer clicks Reveal, so a shared screen never shows it by accident. */
export function SecretInput({
  label,
  ...input
}: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="secret-input">
        <input {...input} type={shown ? 'text' : 'password'} spellCheck={false} />
        <RevealButton shown={shown} label={label} onToggle={() => setShown((s) => !s)} />
      </span>
    </label>
  );
}

export function SecretText({ value, label }: { value: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret-text">
      <code className={shown ? 'code' : 'code blurred'} aria-hidden={!shown}>
        {value}
      </code>
      <RevealButton shown={shown} label={label} onToggle={() => setShown((s) => !s)} />
    </span>
  );
}
