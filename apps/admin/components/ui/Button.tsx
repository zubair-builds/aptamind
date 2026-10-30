'use client';

import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import s from './Button.module.css';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const cls = (variant: ButtonVariant, size: ButtonSize, extra?: string) =>
  [s.button, s[variant], s[size], extra].filter(Boolean).join(' ');

/** Text button. `pending` disables it and shows a spinner with "Working…" (aria-busy). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  pending = false,
  pendingLabel = 'Working…',
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  pending?: boolean;
  pendingLabel?: string;
}) {
  return (
    <button
      type={type}
      className={cls(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <span className={s.spinner} aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      <span>{pending ? pendingLabel : children}</span>
    </button>
  );
}

/** A link that looks like a button (navigation, not an action). */
export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cls(variant, size, className)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </Link>
  );
}

/** Icon-only button: `label` is both its accessible name and its tooltip. */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'sm',
  className,
  type = 'button',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  icon: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <Tooltip content={label} describe={false}>
      <button
        type={type}
        aria-label={label}
        className={cls(variant, size, `${s.iconOnly} ${className ?? ''}`)}
        {...rest}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
