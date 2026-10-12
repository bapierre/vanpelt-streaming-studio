import { useState } from 'react';

const KEY = 'streamhub.scenePreviews';

/** Private windows and locked-down webviews can throw on storage access; the toggle is only a convenience. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Scene previews in the Live tab. Default on; they can be switched off if the GPU cost bites. */
export function loadPreviewPref(): boolean {
  try {
    return storage()?.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function savePreviewPref(on: boolean) {
  try {
    storage()?.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Not saved; the toggle still works for this session.
  }
}

export function usePreviewPref(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(loadPreviewPref);
  const update = (next: boolean) => {
    savePreviewPref(next);
    setOn(next);
  };
  return [on, update];
}
