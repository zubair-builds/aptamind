import type { ReactNode } from 'react';
import type { StatusTone } from '@/components/ui/StatusPill';
import { enumLabel } from '@/lib/format';
import { type ToneKind, toneFor as statusToneFor } from '@/lib/tones';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'accent';

export function Badge({
  tone = 'muted',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

const LEGACY: Record<StatusTone, Tone> = {
  neutral: 'muted',
  info: 'info',
  success: 'ok',
  warning: 'warn',
  danger: 'bad',
  accent: 'accent',
};

export type BadgeKind = ToneKind;

export function toneFor(value: string | null | undefined, kind: BadgeKind = 'generic'): Tone {
  return LEGACY[statusToneFor(value, kind)];
}

/** Badge coloured by a well-known status value; the text always carries the meaning. */
export function StatusBadge({
  value,
  kind = 'generic',
  label,
  title,
}: {
  value: string | null | undefined;
  kind?: BadgeKind;
  label?: ReactNode;
  title?: string;
}) {
  // Enum values read in sentence case ("Verified live", not "VERIFIED LIVE"); the value itself is
  // unchanged (tone lookup, tests, filters).
  const text = label ?? (value ? enumLabel(value) : 'Unknown');
  return (
    <Badge tone={toneFor(value, kind)} title={title}>
      {kind === 'confidence' ? <>conf: {text}</> : text}
    </Badge>
  );
}

export function BoolBadge({
  value,
  yes = 'yes',
  no = 'no',
}: {
  value: boolean | null | undefined;
  yes?: string;
  no?: string;
}) {
  if (value === null || value === undefined) return <Badge tone="muted">unknown</Badge>;
  return <Badge tone={value ? 'ok' : 'muted'}>{value ? yes : no}</Badge>;
}
