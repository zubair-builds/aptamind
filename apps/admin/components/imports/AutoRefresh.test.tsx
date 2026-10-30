// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoRefresh } from './AutoRefresh';

const refresh = vi.fn();
// Next's router object is stable across renders; so is this one.
const router = { refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('AutoRefresh', () => {
  it('refreshes every 3 s while things are fine', () => {
    render(<AutoRefresh />);
    advance(9000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('backs off after failed refreshes (6, 12, 24, 30, 30 s) and recovers', () => {
    const view = render(<AutoRefresh />);
    advance(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(<AutoRefresh failing />);
    for (const [wait, calls] of [
      [6000, 2],
      [12000, 3],
      [24000, 4],
      [30000, 5],
      [30000, 6],
    ] as const) {
      advance(wait - 1);
      expect(refresh).toHaveBeenCalledTimes(calls - 1);
      advance(1);
      expect(refresh).toHaveBeenCalledTimes(calls);
    }
    view.rerender(<AutoRefresh />);
    advance(3000);
    expect(refresh).toHaveBeenCalledTimes(7);
  });
});
