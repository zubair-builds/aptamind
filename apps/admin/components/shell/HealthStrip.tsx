'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { HealthRecheck } from './HealthRecheck';
import s from './Shell.module.css';

/**
 * Dismissal lives in sessionStorage (this tab, this browser session), keyed by the failure
 * signature: a different kind of failure shows the notice again, and recovery clears it (see
 * HealthNoticeReset) so the same failure coming back later is shown too.
 */
export const DISMISS_KEY = 'aptamind.healthNotice.dismissed';

export function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function writeDismissed(signature: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, signature);
  } catch {
    // Storage unavailable (private mode, quota): dismissal then lasts until the next render only.
  }
}

export function clearDismissed(): void {
  try {
    window.sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

/** One calm, compact strip under the top bar while a dependency is down. */
export function HealthStrip({
  signature,
  headline,
  detail,
  devHints = [],
}: {
  signature: string;
  headline: string;
  detail: string;
  devHints?: string[];
}) {
  // Start hidden until sessionStorage has been read so a dismissed notice never flashes after a
  // navigation or an automatic refresh (the server always renders the strip).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(readDismissed() !== signature);
  }, [signature]);

  // Keep re-checking silently while hidden, so recovery still clears the stored dismissal.
  if (!shown) return <HealthRecheck visible={false} />;
  return (
    <div className={s.notice} role="status" data-signature={signature}>
      <Icon name="circle-alert" className={s.noticeIcon} />
      <div className={s.noticeBody}>
        <p className={s.noticeText}>
          <strong>{headline}</strong> {detail}
        </p>
        {devHints.length ? (
          <details className={s.noticeDetails}>
            <summary>Local setup hint</summary>
            <ul>
              {devHints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className={s.noticeActions}>
        <HealthRecheck />
        <Link href="/settings/system#api" className={s.noticeLink}>
          Details
        </Link>
        <IconButton
          label="Dismiss"
          icon="x"
          onClick={() => {
            writeDismissed(signature);
            setShown(false);
          }}
        />
      </div>
    </div>
  );
}

/** Rendered while the API is ready: forgets any dismissal, so the next failure is shown. */
export function HealthNoticeReset() {
  useEffect(() => clearDismissed(), []);
  return null;
}
