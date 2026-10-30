'use client';

import { useId, useState } from 'react';
import s from './facts.module.css';

/** Quotes longer than this are clamped to two lines with a control to read the rest. */
export const QUOTE_CLAMP_CHARS = 120;

/** An evidence quote: clamped to two lines, with "Show full quote" when it is long. */
export function ExpandableQuote({ quote }: { quote: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = quote.length > QUOTE_CLAMP_CHARS;
  return (
    <div className={s.quoteBox}>
      <blockquote id={id} className={s.quote} data-expanded={open || !long || undefined}>
        {quote}
      </blockquote>
      {long ? (
        <button
          type="button"
          className={s.quoteToggle}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show full quote'}
        </button>
      ) : null}
    </div>
  );
}
