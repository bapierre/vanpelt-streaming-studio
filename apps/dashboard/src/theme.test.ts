// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyAppearance } from './theme';

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('applyAppearance', () => {
  it('sets the theme the preference asks for', () => {
    applyAppearance('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyAppearance('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the system, which jsdom reports as light', () => {
    applyAppearance('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
