'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const MAX_DELAY_MS = 30_000;

/**
 * Re-renders the page from the server while it is visible: every `everyMs`, or with backoff
 * (6 s, 12 s, 24 s, then 30 s) while the last render showed an error. It never stops by itself;
 * the page stops rendering it once the import has finished.
 */
export function AutoRefresh({ everyMs = 3000, failing = false }: { everyMs?: number; failing?: boolean }) {
  const router = useRouter();
  // Restarts whenever `failing` flips: a new error starts the backoff, a success resets it.
  useEffect(() => {
    let failures = failing ? 1 : 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = failures ? Math.min(everyMs * 2 ** failures, MAX_DELAY_MS) : everyMs;
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') router.refresh();
        if (failing) failures++;
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [router, everyMs, failing]);
  return null;
}
