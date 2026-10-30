'use client';

import Link from 'next/link';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';
import s from './Toast.module.css';

export interface ToastInput {
  message: string;
  tone?: 'success' | 'info';
  href?: string;
  hrefLabel?: string;
}

interface ToastEntry extends ToastInput {
  id: number;
}

const DURATION_MS = 6000;
const ToastContext = createContext<(t: ToastInput) => void>(() => {});

/**
 * Toasts for results that are not shown inline (e.g. "Run started · View run"). Errors belong in
 * an inline alert next to the control, not here.
 */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seq = useRef(0);
  const show = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <section className={s.viewport} aria-label="Notifications">
        {/* The live region holds only the message text: links and dismiss buttons are not read out. */}
        {/* aria-atomic=false: a new toast is read on its own, queued ones are not re-read. */}
        <div role="status" aria-atomic="false" className="sr-only">
          {toasts.map((t) => (
            <span key={t.id}>{t.message}. </span>
          ))}
        </div>
        <div className={s.stack}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismiss(toast.id), DURATION_MS);
    return () => clearTimeout(t);
  }, [paused, toast.id, onDismiss]);
  return (
    <div
      className={s.toast}
      data-tone={toast.tone ?? 'success'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={s.message}>{toast.message}</span>
      {toast.href ? (
        <Link href={toast.href} className={s.link}>
          {toast.hrefLabel ?? 'Open'}
        </Link>
      ) : null}
      <IconButton label="Dismiss notification" icon="x" onClick={() => onDismiss(toast.id)} />
    </div>
  );
}
