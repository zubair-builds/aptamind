import type { ReactNode } from 'react';
import s from './Kbd.module.css';

/** Keyboard key hint, e.g. <Kbd>⌘K</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}
