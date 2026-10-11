// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from '../prefs';
import { TabBar, useTabs } from './Tabs';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Harness({ prefs = DEFAULT_PREFS }: { prefs?: Prefs }) {
  const [tab, setTab] = useTabs(prefs);
  return (
    <>
      <TabBar tab={tab} onSelect={setTab} attention={['settings']} />
      <output aria-label="current">{tab}</output>
    </>
  );
}

const current = () => screen.getByLabelText('current').textContent;
const press = (key: string, meta = true) => fireEvent.keyDown(window, { key, metaKey: meta });

describe('tabs', () => {
  it('opens on Live and switches by click, remembering the tab', () => {
    render(<Harness />);
    expect(current()).toBe('live');
    expect(screen.getByRole('tab', { name: 'Live' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Sound' }));
    expect(current()).toBe('sound');
    expect(localStorage.getItem('streamhub.lastTab')).toBe('sound');
  });

  it('switches with ⌘1–4 and opens Settings with ⌘,', () => {
    render(<Harness />);
    press('3');
    expect(current()).toBe('chat');
    press('4');
    expect(current()).toBe('settings');
    press('2');
    expect(current()).toBe('sound');
    press(',');
    expect(current()).toBe('settings');
    press('1');
    expect(current()).toBe('live');
  });

  it('ignores keys without ⌘ and numbers without a tab', () => {
    render(<Harness />);
    press('2', false);
    press('5');
    press('0');
    expect(current()).toBe('live');
  });

  it('reopens the last tab, but never Settings', () => {
    localStorage.setItem('streamhub.lastTab', 'chat');
    render(<Harness />);
    expect(current()).toBe('chat');
    cleanup();
    localStorage.setItem('streamhub.lastTab', 'settings');
    render(<Harness />);
    expect(current()).toBe('live');
  });

  it('opens on the chosen start tab when one is set', () => {
    localStorage.setItem('streamhub.lastTab', 'chat');
    render(<Harness prefs={{ ...DEFAULT_PREFS, startTab: 'sound' }} />);
    expect(current()).toBe('sound');
  });

  it('shows when a tab needs attention and names the shortcut', () => {
    render(<Harness />);
    const settings = screen.getByRole('tab', { name: /Settings/ });
    expect(settings.querySelector('.attention')).toBeTruthy();
    expect(settings.title).toBe('Settings (⌘4)');
  });
});

describe('prefs', () => {
  it('round-trips and falls back on bad values', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    savePrefs({ startTab: 'chat', chatSize: 'large' });
    expect(loadPrefs()).toEqual({ startTab: 'chat', chatSize: 'large' });
    localStorage.setItem('streamhub.prefs', JSON.stringify({ startTab: 'settings', chatSize: 'huge' }));
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem('streamhub.prefs', '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});
