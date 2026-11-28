'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useTransition } from 'react';
import { Button } from '@/components/ui/Button';

/** Automatic re-checks while the API is degraded: backoff, then stop (the "Retry now" button stays). */
export const RECHECK_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 120_000] as const;

/**
 * Re-renders the route (server components re-run the readiness probe) on a bounded backoff, never
 * while the tab is hidden. When the API is ready again the shell notice simply disappears.
 */
export function HealthRecheck({ visible = true }: { visible?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = useCallback(() => start(() => router.refresh()), [router]);
  // The schedule lives for the mount: a re-render (new router/refresh identity) must not reset it.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingForVisible = false;

    const schedule = () => {
      const delay = RECHECK_DELAYS_MS[attempt];
      if (delay === undefined) return;
      timer = setTimeout(fire, delay);
    };
    const run = () => {
      attempt += 1;
      refreshRef.current();
      schedule();
    };
    function fire() {
      if (document.hidden) {
        waitingForVisible = true;
        return;
      }
      run();
    }
    const onVisibility = () => {
      if (!document.hidden && waitingForVisible) {
        waitingForVisible = false;
        run();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!visible) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="rotate-cw"
      pending={pending}
      pendingLabel="Retrying…"
      onClick={refresh}
    >
      Retry now
    </Button>
  );
}
