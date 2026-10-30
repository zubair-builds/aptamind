'use client';

import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { isQuietFocus, type Placement, useEscapeLayer, useFloating } from './floating';
import s from './overlay.module.css';

const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 100;

/**
 * Tooltip on hover (after a short delay) and on keyboard focus; Escape hides it and the pointer
 * may move onto it (WCAG 1.4.13). `describe` links it via aria-describedby — turn it off when the
 * content only repeats the trigger's accessible name (icon buttons).
 *
 * The child is cloned, so create it in a client component: an element passed down from a server
 * component may arrive as a lazy Flight reference, which cannot be cloned.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  describe = true,
}: {
  content: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: Placement;
  describe?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useFloating(open, anchor, tip, placement);

  const schedule = useCallback((next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Escape hides only the tooltip (it is the top layer), never a surrounding dialog or popover.
  useEscapeLayer(
    open,
    () => {
      clearTimeout(timer.current);
      setOpen(false);
    },
    anchor,
  );

  if (!isValidElement(children)) {
    throw new Error('Tooltip: `children` must be an element created in a client component.');
  }

  const trigger = describe
    ? cloneElement(children, {
        'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' '),
      })
    : children;

  return (
    <span
      ref={anchor}
      className={s.anchor}
      onPointerEnter={() => schedule(true, SHOW_DELAY_MS)}
      onPointerLeave={() => schedule(false, HIDE_DELAY_MS)}
      onFocus={(e) => {
        // Focus handed back by a closing layer is not a reason to show the tooltip.
        if (isQuietFocus()) return;
        let keyboard = true;
        try {
          keyboard = (e.target as HTMLElement).matches(':focus-visible');
        } catch {
          /* selector unsupported: treat as keyboard focus */
        }
        if (keyboard) schedule(true, 0);
      }}
      onBlur={() => schedule(false, 0)}
    >
      {trigger}
      {/* The description source: hidden, so it is always resolvable and never read twice. */}
      {describe ? (
        <span id={id} hidden>
          {content}
        </span>
      ) : null}
      {open ? (
        <div
          ref={tip}
          popover="manual"
          aria-hidden="true"
          className={s.tooltip}
          onPointerEnter={() => schedule(true, 0)}
          onPointerLeave={() => schedule(false, HIDE_DELAY_MS)}
        >
          {content}
        </div>
      ) : null}
    </span>
  );
}
