// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubClient } from '@streamhub/overlay-sdk';
import type { Envelope } from '@streamhub/shared';
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

/** An open hub that replays the given events to every subscriber whose topic prefix matches. */
function hubWith(events: Envelope[]): HubClient {
  return {
    ...quietHub(),
    onStatus: (h) => (h('open'), () => {}),
    on: (topic, h) => {
      for (const e of events) if (e.type.startsWith(topic)) h(e);
      return () => {};
    },
  };
}

const event = (type: string, payload: unknown) => ({ id: type, ts: 0, source: 'hub', type, payload }) as Envelope;

describe('App', () => {
  it('keeps Record and Go live on every tab, and has no Chat tab any more', () => {
    render(<App client={quietHub()} />);
    expect(screen.queryByRole('tab', { name: /^Chat/ })).toBeNull();
    for (const [tab, id] of [
      ['Live', 'live'],
      ['Sound', 'sound'],
      ['On screen', 'onscreen'],
      ['Settings', 'settings'],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }));
      expect(screen.getByRole('tabpanel').id).toBe(`panel-${id}`);
      expect(screen.getByRole('button', { name: /Record/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Go live' })).toBeTruthy();
    }
  });

  it('opens Settings with ⌘, and shows each tab its own content', () => {
    render(<App client={quietHub()} />);
    expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(screen.getByRole('region', { name: 'Setup overview' })).toBeTruthy();
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    expect(screen.getByText(/Waiting for the hub/)).toBeTruthy();
    fireEvent.keyDown(window, { key: '3', metaKey: true });
    expect(screen.getByRole('region', { name: 'Alerts' })).toBeTruthy();
  });

  it('says when the hub or OBS is offline, with a way to fix it', () => {
    render(<App client={quietHub()} />);
    expect(screen.getByRole('status').textContent).toContain('Lost the connection to the streamhub hub');
    cleanup();
    render(<App client={hubWith([event('obs.connection', { connected: false, detail: 'ECONNREFUSED' })])} />);
    expect(screen.getByRole('status').textContent).toContain('OBS is not connected');
    fireEvent.click(screen.getByRole('button', { name: 'OBS settings' }));
    expect(screen.getByRole('region', { name: 'OBS' })).toBeTruthy();
  });

  it('warns about disk space in the toolbar, but only while OBS is connected', () => {
    const disk = event('recording.state', {
      output: 'stopped',
      directory: '/x',
      cameras: [],
      disk: { path: '/x', freeBytes: 3 * 1024 ** 3, level: 'critical' },
    });
    render(<App client={hubWith([event('obs.connection', { connected: true }), disk])} />);
    expect(within(screen.getByRole('banner')).getByRole('alert').textContent).toContain('Disk almost full');
    cleanup();
    render(<App client={hubWith([event('obs.connection', { connected: false }), disk])} />);
    expect(within(screen.getByRole('banner')).queryByRole('alert')).toBeNull();
  });

  it('takes a pre-flight fix straight to the right page, and forgets it after', () => {
    render(<App client={hubWith([event('obs.connection', { connected: false })])} />);
    fireEvent.click(screen.getByRole('button', { name: /^Pre-flight: \d+ problem/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open OBS settings' }));
    expect(screen.getByRole('tabpanel').id).toBe('panel-settings');
    expect(screen.getByRole('region', { name: 'OBS' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /^Live/ }));
    fireEvent.click(screen.getByRole('tab', { name: /^Settings/ }));
    expect(screen.getByRole('region', { name: 'Setup overview' })).toBeTruthy();
  });
});
