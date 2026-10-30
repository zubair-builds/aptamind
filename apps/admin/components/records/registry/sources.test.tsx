// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceListItem } from '@/lib/types';
import { sourcesObject } from './sources';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
afterEach(cleanup);

const column = sourcesObject.columns.find((c) => c.key === 'nextRun')!;
const cell = (r: Partial<SourceListItem>) =>
  render(<div>{column.cell({ enabled: true, ...r } as SourceListItem)}</div>).container;

const schedule = (s: Partial<NonNullable<SourceListItem['schedule']>>) => ({
  timezone: 'UTC',
  enabled: true,
  nextRunAt: null,
  lastFiredAt: null,
  ...s,
});

describe('sources Next run column', () => {
  it('is shown by default', () => {
    expect(column.defaultVisible).toBe(true);
  });

  it('shows the next run time from the API', () => {
    const el = cell({ schedule: schedule({ cron: '0 6 * * *', nextRunAt: '2026-10-02T06:00:00.000Z' }) });
    expect(el.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-02T06:00:00.000Z');
  });

  it('says why there is no next run', () => {
    expect(cell({ schedule: null }).textContent).toBe('—');
    expect(cell({}).textContent).toBe('—');
    expect(cell({ schedule: schedule({ enabled: false }) }).textContent).toBe('paused');
    expect(cell({ schedule: schedule({}) }).textContent).toBe('not planned');
    expect(cell({ enabled: false, schedule: schedule({}) }).textContent).toBe('source disabled');
  });
});
