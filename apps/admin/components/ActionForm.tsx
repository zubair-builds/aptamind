'use client';

import Link from 'next/link';
import { type FormEvent, type ReactNode, useActionState, useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/Toast';
import { type ActionState, IDLE, type ServerAction } from '@/lib/action-state';

/** Inline result of a Server Action (success with optional link, or API error code/message). */
export function ActionResult({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'ok') {
    return (
      <div className="action-result action-ok" role="status">
        {state.message}{' '}
        {state.href ? (
          <Link href={state.href} className="action-link">
            {state.hrefLabel ?? 'Open'} →
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <div className="action-result action-error" role="alert">
      <code>{state.code}</code>: {state.message}
      {state.details ? (
        <details>
          <summary>Details</summary>
          <pre>{state.details}</pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Form bound to a Server Action via useActionState. Hidden inputs go in `hidden`; visible
 * fields in `children`. Optional confirmation prompt for destructive/expensive operations.
 */
export function ActionForm({
  action,
  submitLabel,
  hidden = {},
  children,
  confirmMessage,
  variant = 'default',
  inline = false,
  className,
  feedback = 'inline',
}: {
  action: ServerAction;
  submitLabel: string;
  hidden?: Record<string, string>;
  children?: ReactNode;
  confirmMessage?: string;
  variant?: 'default' | 'primary' | 'danger';
  inline?: boolean;
  className?: string;
  /** `toast`: successes become a toast (with the result link); errors always stay inline. */
  feedback?: 'inline' | 'toast';
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const toast = useToast();
  // One toast per result: StrictMode re-runs effects in development, and the ref survives that.
  const toasted = useRef<ActionState | null>(null);
  useEffect(() => {
    if (feedback !== 'toast' || state.status !== 'ok' || toasted.current === state) return;
    toasted.current = state;
    toast({ message: state.message, href: state.href, hrefLabel: state.hrefLabel });
  }, [feedback, state, toast]);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
  };
  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className={[inline ? 'action-form inline' : 'action-form', className].filter(Boolean).join(' ')}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <div className="action-row">
        <button type="submit" className={`btn btn-${variant}`} disabled={pending} aria-busy={pending}>
          {pending ? 'Working…' : submitLabel}
        </button>
      </div>
      {feedback === 'toast' && state.status === 'ok' ? null : <ActionResult state={state} />}
    </form>
  );
}
