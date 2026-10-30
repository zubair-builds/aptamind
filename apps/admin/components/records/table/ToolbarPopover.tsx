'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';

/**
 * A view-bar control ("Filter", "Columns") whose panel is a server-rendered GET form. The trigger
 * is created here, on the client: `Popover` clones it (see `records/facts/FactPopover`).
 */
export function ToolbarPopover({
  label,
  text,
  count,
  wide = false,
  children,
}: {
  /** Accessible name of the panel. */
  label: string;
  text: string;
  /** Active items (e.g. filters), shown after the text. */
  count?: number;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover
      label={label}
      size={wide ? 'wide' : 'default'}
      trigger={
        <Button size="sm">
          {text}
          {count ? (
            <>
              {' '}
              <span aria-hidden="true">· {count}</span>
              <span className="sr-only">({count} active)</span>
            </>
          ) : null}
        </Button>
      }
    >
      {children}
    </Popover>
  );
}
