'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Menu } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { PropertyList } from '@/components/ui/PropertyList';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import s from './catalogue.module.css';

export function PendingDemo() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="primary"
      pending={pending}
      onClick={() => {
        setPending(true);
        setTimeout(() => setPending(false), 1500);
      }}
    >
      Run now
    </Button>
  );
}

export function TooltipDemo() {
  return (
    <Tooltip content="Runs the source's acquisition workflow once">
      <Button>Hover or focus me</Button>
    </Tooltip>
  );
}

export function PopoverDemo() {
  return (
    <Popover label="Provenance" trigger={<Button size="sm">2 sources</Button>}>
      <PropertyList
        items={[
          { label: 'Source', value: 'Acme Ltd (greenhouse)' },
          { label: 'Observed', value: '2h ago' },
        ]}
      />
    </Popover>
  );
}

export function MenuDemo() {
  const toast = useToast();
  const [last, setLast] = useState('none');
  const pick = (label: string) => () => setLast(label);
  return (
    <div className={s.row}>
      <Menu
        label="Record actions"
        items={[
          { label: 'Copy id', shortcut: 'c i', onSelect: pick('Copy id') },
          { label: 'Copy link', shortcut: 'c l', onSelect: pick('Copy link') },
          { label: 'Open raw JSON', disabled: true },
          'separator',
          {
            label: 'Disable source',
            danger: true,
            onSelect: () => toast({ message: 'Would ask to confirm' }),
          },
        ]}
      />
      <Menu
        label="Sort"
        buttonLabel="Sort"
        placement="bottom-start"
        items={[
          { label: 'Newest first', onSelect: pick('Newest first') },
          { label: 'Oldest first', onSelect: pick('Oldest first') },
        ]}
      />
      <span>Last chosen: {last}</span>
    </div>
  );
}

export function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Disable source?"
        description="Scheduled refreshes stop until it is enabled again. Existing data is kept."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              Disable
            </Button>
          </>
        }
      >
        {/* Nested layer: Escape closes this popover first, then the dialog. */}
        <Popover label="What is kept" trigger={<Button size="sm">What is kept?</Button>}>
          <div className={s.popoverBody}>
            <p>Observations, snapshots and raw artifacts stay; only new runs stop.</p>
            <Button size="sm">Got it</Button>
          </div>
        </Popover>
      </Dialog>
    </>
  );
}

export function TabsDemo() {
  return (
    <Tabs
      label="Record sections"
      tabs={[
        { id: 'overview', label: 'Overview', content: <p>Properties grouped by topic.</p> },
        { id: 'evidence', label: 'Evidence', count: 12, content: <p>Per-field evidence and conflicts.</p> },
        { id: 'activity', label: 'Activity', content: <p>One timeline, newest first.</p> },
        { id: 'debug', label: 'Debug', content: <p>Ids, versions and raw JSON.</p> },
      ]}
    />
  );
}

export function ToastDemo() {
  const toast = useToast();
  return (
    <Button onClick={() => toast({ message: 'Run started', href: '/runs', hrefLabel: 'View run' })}>
      Show toast
    </Button>
  );
}
