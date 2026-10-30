import { describe, expect, it } from 'vitest';
import { loggableUrl } from './request-log';

describe('loggableUrl', () => {
  it('drops the query string everywhere', () => {
    expect(loggableUrl({ url: '/api/runs/run_1?note=x' })).toBe('/api/runs/run_1');
    expect(loggableUrl({ url: '/api/sources' })).toBe('/api/sources');
  });

  it('logs private-domain paths as their route template, or a placeholder', () => {
    expect(
      loggableUrl({
        url: '/api/professional/subjects/psub_1?reference=x',
        routeOptions: { url: '/api/professional/subjects/:id' },
      }),
    ).toBe('/api/professional/subjects/:id');
    expect(loggableUrl({ url: '/api/professional/secret/path' })).toBe('/api/professional/[unmatched]');
    expect(loggableUrl({ url: '/api/professional?x=1' })).toBe('/api/professional/[unmatched]');
    // Only the exact prefix segment is private.
    expect(loggableUrl({ url: '/api/professionals/x' })).toBe('/api/professionals/x');
  });
});
