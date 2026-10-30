'use client';

import type { ReactNode } from 'react';
import { IconButton } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';

/** Row preview: an icon button next to the record name opening its key properties. */
export function RowPeek({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Popover
      label={`Preview: ${name}`}
      trigger={<IconButton icon="eye" label={`Preview ${name}`} />}
      // Back to the row's link (the one Tab stop of the row), not the out-of-order preview button.
      returnFocusTo={(anchor) => anchor.closest('tr')?.querySelector<HTMLElement>('[data-row-link]')}
    >
      {children}
    </Popover>
  );
}
