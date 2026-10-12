// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Check } from '../preflight';
import { Preflight } from './Preflight';

afterEach(cleanup);

const checks: Check[] = [
  { id: 'obs', status: 'ok', title: 'OBS is connected' },
  { id: 'mic-guest', status: 'warn', title: 'Guest is muted', fix: { tab: 'sound', label: 'Open Sound' } },
  { id: 'stream-key', status: 'fail', title: 'OBS has no stream key', detail: 'Save one on its platform page and click Use in OBS.', fix: { tab: 'settings', section: 'twitch', label: 'Add a stream key' } },
];

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Pre-flight/ }));

describe('Preflight', () => {
  it('sums up the checks on the button', () => {
    const { rerender } = render(<Preflight checks={checks} onFix={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pre-flight: 1 problem' })).toBeTruthy();
    rerender(<Preflight checks={checks.slice(0, 2)} onFix={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pre-flight: 1 to check' })).toBeTruthy();
    rerender(<Preflight checks={checks.slice(0, 1)} onFix={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pre-flight: All good' })).toBeTruthy();
  });

  it('lists problems first, then warnings, then what passed', () => {
    render(<Preflight checks={checks} onFix={vi.fn()} />);
    open();
    const items = within(screen.getByRole('region', { name: 'Pre-flight checks' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      '×Problem: OBS has no stream keySave one on its platform page and click Use in OBS.Add a stream key',
      '!Check: Guest is mutedOpen Sound',
      '✓OK: OBS is connected',
    ]);
  });

  it('closes and hands over the fix when one is clicked', () => {
    const onFix = vi.fn();
    render(<Preflight checks={checks} onFix={onFix} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add a stream key' }));
    expect(onFix).toHaveBeenCalledWith({ tab: 'settings', section: 'twitch', label: 'Add a stream key' });
    expect(screen.queryByRole('region', { name: 'Pre-flight checks' })).toBeNull();
  });

  it('closes on Escape and on a click outside', () => {
    render(<Preflight checks={checks} onFix={vi.fn()} />);
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Pre-flight checks' })).toBeNull();
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('region', { name: 'Pre-flight checks' })).toBeNull();
  });
});
