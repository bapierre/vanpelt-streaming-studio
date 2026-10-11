// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendCell } from './HeadsetMatrix';

// Count actual renders of the cell's slider to prove the memo boundary holds.
const rangeRenders = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock('./ThrottledRange', () => ({
  RANGE_SEND_MS: 250,
  ThrottledRange: (props: { label: string }) => {
    rangeRenders.labels.push(props.label);
    return <input aria-label={props.label} />;
  },
}));

afterEach(cleanup);

const base = {
  headsetId: 'guest',
  headsetName: 'Guest headset',
  sourceKey: 'mic:host',
  sourceName: 'Host',
  self: false,
  disabled: false,
  onSetSend: () => {},
};
const cell = (p: { on: boolean; db: number }) => (
  <table>
    <tbody>
      <tr>
        <SendCell {...base} {...p} />
      </tr>
    </tbody>
  </table>
);

describe('SendCell memoization', () => {
  it('re-renders only when its primitive props change', () => {
    const { rerender } = render(cell({ on: true, db: 0 }));
    expect(rangeRenders.labels).toHaveLength(1);
    // A headsets.state tick with the same values must not re-render the cell.
    rerender(cell({ on: true, db: 0 }));
    expect(rangeRenders.labels).toHaveLength(1);
    rerender(cell({ on: true, db: -3 }));
    expect(rangeRenders.labels).toHaveLength(2);
    rerender(cell({ on: false, db: -3 }));
    expect(rangeRenders.labels).toHaveLength(3);
  });
});
