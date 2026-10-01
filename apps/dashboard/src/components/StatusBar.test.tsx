// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { initialState } from '../state';
import { StatusBar } from './StatusBar';

afterEach(cleanup);

describe('StatusBar', () => {
  it('does not claim the stream is live while OBS is disconnected', () => {
    render(
      <StatusBar
        state={{
          ...initialState,
          hubConnected: true,
          obs: { connected: false, detail: 'socket closed' },
          stream: { state: 'live', startedAt: 0 },
        }}
      />,
    );
    const text = screen.getByRole('contentinfo').textContent ?? '';
    expect(text).toContain('stream unknown');
    expect(text).not.toMatch(/\blive\b/);
  });
});
