import type { ReactNode } from 'react';

export function Empty({ children = 'Nothing to show.' }: { children?: ReactNode }) {
  return <p className="empty">{children}</p>;
}
