'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useTransition } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import s from './States.module.css';

/**
 * Calm danger callout for a failed request. Keeps every diagnostic the operator needs (code,
 * HTTP status, request id, path) and offers a retry; never a stack trace.
 */
export function ErrorState({
  title,
  message,
  meta,
  details,
  retry = true,
  announce = true,
}: {
  title: string;
  message: ReactNode;
  /** Diagnostic line, e.g. "GET /api/jobs — request req_123". */
  meta?: ReactNode;
  details?: string;
  retry?: boolean;
  /** `role="alert"` (default); off for static examples that must not interrupt. */
  announce?: boolean;
}) {
  return (
    <div className={s.error} role={announce ? 'alert' : undefined}>
      <Icon name="circle-alert" className={s.errorIcon} />
      <div className={s.errorBody}>
        <h2 className={s.errorTitle}>{title}</h2>
        <div>{message}</div>
        {meta ? <p className={s.meta}>{meta}</p> : null}
        {details ? (
          <details className={s.details}>
            <summary>Details</summary>
            <pre>{details}</pre>
          </details>
        ) : null}
        {retry ? <RetryButton /> : null}
      </div>
    </div>
  );
}

/** Re-renders the current route (server data included). */
export function RetryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className={s.actions}>
      <Button size="sm" icon="rotate-cw" pending={pending} onClick={() => start(() => router.refresh())}>
        Retry
      </Button>
    </div>
  );
}
