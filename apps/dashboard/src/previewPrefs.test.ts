// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPreviewPref, savePreviewPref, usePreviewPref } from './previewPrefs';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('scene preview preference', () => {
  it('is on by default and remembers being switched off', () => {
    expect(loadPreviewPref()).toBe(true);
    const { result } = renderHook(() => usePreviewPref());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem('streamhub.scenePreviews')).toBe('off');
    expect(loadPreviewPref()).toBe(false);
    cleanup();
    expect(renderHook(() => usePreviewPref()).result.current[0]).toBe(false);
  });

  it('stays on when storage is locked down', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('locked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('locked');
    });
    expect(loadPreviewPref()).toBe(true);
    expect(() => savePreviewPref(false)).not.toThrow();
    const { result } = renderHook(() => usePreviewPref());
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false); // the toggle still works for this session
  });
});
