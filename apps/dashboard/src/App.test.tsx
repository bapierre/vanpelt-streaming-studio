// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import { App } from './App';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A hub that never says anything: enough to render every tab. */
function quietHub(): HubClient {
  return {
    on: () => () => {},
    onStatus: () => () => {},
    onError: () => () => {},
    history: async () => [],
    publish: () => {},
    close: () => {},
  };
}

describe('App', () => {
  it('keeps Record, Go Live and the status bar on every tab', () => {
    render(<App client={quietHub()} />);
    for (const tab of ['Live', 'Sound', 'Chat', 'Settings']) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }));
      expect(screen.getByRole('tabpanel').id).toBe(`panel-${tab.toLowerCase()}`);
      expect(screen.getByRole('button', { name: /Record/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Start stream' })).toBeTruthy();
      expect(document.querySelector('.status-bar')).toBeTruthy();
    }
  });

  it('opens Settings on General with ⌘, and shows each tab its own content', () => {
    render(<App client={quietHub()} />);
    expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(screen.getByRole('region', { name: 'General' })).toBeTruthy();
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    expect(screen.getByText(/Waiting for the hub/)).toBeTruthy();
    fireEvent.keyDown(window, { key: '3', metaKey: true });
    expect(screen.getByRole('searchbox', { name: 'Search chat' })).toBeTruthy();
  });
});
