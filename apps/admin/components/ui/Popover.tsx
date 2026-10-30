'use client';

import {
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { type DismissReason, focusQuietly, type Placement, useDismiss, useFloating } from './floating';
import s from './overlay.module.css';

interface TriggerProps {
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  'aria-haspopup'?: 'dialog';
}

/**
 * Non-modal popover anchored to `trigger` (a button). Opening moves focus into the panel;
 * Escape, a click outside or focus leaving it closes it, and Escape returns focus to the trigger.
 * Only the innermost open layer reacts to Escape (layer stack in `floating.ts`).
 *
 * The trigger is cloned, so create it in a client component: an element passed down from a
 * server component may arrive as a lazy Flight reference, which cannot be cloned.
 */
export function Popover({
  trigger,
  label,
  children,
  placement = 'bottom-start',
  size = 'default',
  returnFocusTo,
}: {
  trigger: ReactElement<TriggerProps>;
  /** Accessible name of the panel. */
  label: string;
  children: ReactNode;
  placement?: Placement;
  /** `wide`: up to 640 px (forms such as a filter panel). */
  size?: 'default' | 'wide';
  /** Where Escape returns focus (default: the trigger), e.g. a table row's own link. */
  returnFocusTo?: (anchor: HTMLElement) => HTMLElement | null | undefined;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(returnFocusTo);
  useLayoutEffect(() => {
    returnFocus.current = returnFocusTo;
  });
  // Focus moves in once the panel is visible (see useFloating), not from the ref callback.
  const focusPanel = useCallback((el: HTMLElement) => {
    const first = el.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex="0"]');
    (first ?? el).focus();
  }, []);
  useFloating(open, anchor, panel, placement, focusPanel);

  const close = useCallback((reason: DismissReason) => {
    setOpen(false);
    if (reason !== 'escape' || !anchor.current) return;
    const custom = returnFocus.current?.(anchor.current);
    focusQuietly(custom ?? anchor.current.querySelector<HTMLElement>('button, [href]'));
  }, []);
  useDismiss(open, [anchor, panel], close);

  if (!isValidElement(trigger)) {
    throw new Error('Popover: `trigger` must be an element created in a client component.');
  }
  return (
    <span ref={anchor} className={s.anchor}>
      {cloneElement(trigger, {
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-haspopup': 'dialog',
        onClick: (e: MouseEvent<HTMLElement>) => {
          trigger.props.onClick?.(e);
          setOpen((o) => !o);
        },
      })}
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          popover="manual"
          tabIndex={-1}
          className={s.popover}
          data-size={size === 'wide' ? 'wide' : undefined}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
