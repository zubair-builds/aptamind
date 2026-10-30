'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import s from './facts.module.css';

/**
 * A fact's popover (provenance, other values, disagreeing values). The trigger button is created
 * here, on the client: `Popover` clones its trigger, and an element handed over from a server
 * component can arrive as a lazy Flight reference that cannot be cloned. The panel content
 * (server-rendered) is passed as children, which never need cloning.
 */
export function FactPopover({
  label,
  text,
  srText,
  tone = 'neutral',
  children,
}: {
  /** Accessible name of the panel. */
  label: string;
  /** Visible button text. */
  text: string;
  /** Screen-reader suffix that makes the button name unique on the page. */
  srText: string;
  /** `warning`: the trigger looks like a warning pill (sources disagree). */
  tone?: 'neutral' | 'warning';
  children: ReactNode;
}) {
  return (
    <Popover
      label={label}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className={tone === 'warning' ? s.disagreeButton : s.provenanceButton}
        >
          {tone === 'warning' ? <span className={s.warningDot} aria-hidden="true" /> : null}
          {text}
          <span className="sr-only">{srText}</span>
        </Button>
      }
    >
      {children}
    </Popover>
  );
}
