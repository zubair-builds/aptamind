'use client';

import { type ReactNode, useState } from 'react';
import { IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import ds from '@/components/ui/Dialog.module.css';
import s from './table.module.css';

/** Row preview: opens a side sheet with the record's key properties. */
export function RowPeek({ name, children }: { name: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton icon="eye" label={`Preview ${name}`} onClick={() => setOpen(true)} />
      <Dialog open={open} onClose={() => setOpen(false)} title={name} className={ds.sheet}>
        <div className={s.peekSheet}>{children}</div>
      </Dialog>
    </>
  );
}
