import type { ReactNode } from 'react';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/** Collapsible JSON viewer (<details><pre>). Text is escaped by React, never rendered as HTML. */
export function JsonView({
  value,
  label = 'JSON',
  open = false,
  maxChars = 200_000,
}: {
  value: unknown;
  label?: ReactNode;
  open?: boolean;
  maxChars?: number;
}) {
  if (value === undefined) return <span className="muted">—</span>;
  const text = safeStringify(value);
  const truncated = text.length > maxChars;
  return (
    <details className="json" open={open}>
      <summary>
        {label} <span className="muted small">({text.length.toLocaleString('en-GB')} chars)</span>
      </summary>
      <pre>
        {truncated ? `${text.slice(0, maxChars)}\n… truncated (${text.length - maxChars} more chars)` : text}
      </pre>
    </details>
  );
}

/** Plain preformatted text block (collapsible). */
export function TextBlock({
  text,
  label,
  open = false,
}: {
  text: string | null | undefined;
  label: ReactNode;
  open?: boolean;
}) {
  if (!text) return <span className="muted">—</span>;
  return (
    <details className="json" open={open}>
      <summary>
        {label} <span className="muted small">({text.length.toLocaleString('en-GB')} chars)</span>
      </summary>
      <pre className="wrap">{text}</pre>
    </details>
  );
}
