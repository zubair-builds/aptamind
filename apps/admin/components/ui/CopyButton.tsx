'use client';

import { type MouseEvent, useEffect, useState } from 'react';
import { IconButton } from './Button';
import s from './CopyButton.module.css';

/**
 * Clipboard write with a fallback for non-secure origins, where `navigator.clipboard` is absent.
 * The fallback's temporary textarea goes next to the button (so inside its popover or dialog:
 * selecting it moves focus, which must not leave the layer or land in an inert page), and focus
 * returns to where it was.
 */
async function writeClipboard(value: string, from: HTMLElement | null) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  (from?.parentElement ?? document.body).append(area);
  area.select();
  try {
    // Deprecated but still the only option without the async Clipboard API.
    if (!document.execCommand('copy')) throw new Error('copy command refused');
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}

/**
 * Copies `value` to the clipboard. The result is visible (check icon, or a "Copy failed" note)
 * and announced politely.
 */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), state === 'failed' ? 4000 : 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async (e: MouseEvent<HTMLButtonElement>) => {
    const button = e.currentTarget;
    try {
      await writeClipboard(value, button);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <IconButton label={label} icon={state === 'copied' ? 'check' : 'copy'} onClick={copy} />
      <span role="status" className={state === 'failed' ? s.failed : 'sr-only'}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select the text instead' : ''}
      </span>
    </>
  );
}
