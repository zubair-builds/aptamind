// @vitest-environment happy-dom
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseView, viewHref } from '@/lib/views';
import { jobsObject } from '../registry/jobs';
import { RecordList } from './RecordList';
import { TableKeys } from './TableKeys';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { items: [{ _id: 'job_1' }], nextCursor: null, total: 1 },
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect ${href}`);
  },
}));

/** Every element of a (server-rendered, not yet mounted) tree. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

describe('RecordList', () => {
  it('keys TableKeys by the view URL, so its row treatment re-runs on every client navigation', async () => {
    const params = { workModel: 'remote', limit: '10' };
    const tree = await RecordList({ def: jobsObject, params });
    const keys = elements(tree).filter((e) => e.type === TableKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.key).toBe(viewHref(jobsObject, parseView(jobsObject, params)));
  });
});
