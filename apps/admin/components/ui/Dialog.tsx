'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import s from './Dialog.module.css';
import { IconButton } from './Button';

/**
 * Modal dialog on the native <dialog> (showModal: focus trap, inert page, top layer; focus
 * returns to the invoker on close). Controlled: Escape, the close button and a backdrop click
 * call `onClose`. A native close the component did not ask for (e.g. Chrome closing a dialog on
 * a repeated Escape without a cancel event) also calls `onClose`, so `open` never desyncs. A
 * backdrop "click" that started inside the content (a text-selection drag) does not close it.
 * Escape inside an open popover/menu/tooltip closes that layer first (layer stack).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        // Closed natively while we still think it is open: report it so the parent can sync.
        if (open) onClose();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // A click on the <dialog> itself (not its content) is a click on the backdrop — but only
        // when the press also started there (not a drag out of selected text).
        const fromBackdrop = downOnBackdrop.current;
        downOnBackdrop.current = false;
        if (fromBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className={s.content}>
          <header className={s.header}>
            <h2 id={titleId} className={s.title}>
              {title}
            </h2>
            <IconButton label="Close dialog" icon="x" onClick={onClose} />
          </header>
          {description ? (
            <p id={descId} className={s.description}>
              {description}
            </p>
          ) : null}
          {children ? <div className={s.body}>{children}</div> : null}
          {footer ? <footer className={s.footer}>{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
