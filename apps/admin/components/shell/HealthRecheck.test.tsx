// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthRecheck, RECHECK_DELAYS_MS } from './HealthRecheck';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('HealthRecheck', () => {
  it('re-checks on a bounded backoff, then stops', () => {
    render(<HealthRecheck />);
    advance(RECHECK_DELAYS_MS[0] - 1);
    expect(refresh).not.toHaveBeenCalled();
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(RECHECK_DELAYS_MS[1]);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const delay of RECHECK_DELAYS_MS.slice(2)) advance(delay);
    expect(refresh).toHaveBeenCalledTimes(RECHECK_DELAYS_MS.length);
    advance(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(RECHECK_DELAYS_MS.length);
  });

  it('waits while the tab is hidden and re-checks when it becomes visible', () => {
    render(<HealthRecheck />);
    hidden = true;
    advance(RECHECK_DELAYS_MS[0]);
    expect(refresh).not.toHaveBeenCalled();
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('offers "Retry now", and keeps checking silently when not visible', () => {
    const { unmount } = render(<HealthRecheck />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    refresh.mockReset();
    render(<HealthRecheck visible={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    advance(RECHECK_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling on unmount', () => {
    const { unmount } = render(<HealthRecheck />);
    unmount();
    advance(RECHECK_DELAYS_MS[0] * 2);
    expect(refresh).not.toHaveBeenCalled();
  });
});
