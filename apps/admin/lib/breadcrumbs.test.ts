import { describe, expect, it } from 'vitest';
import { crumbsFor } from './breadcrumbs';

describe('crumbsFor', () => {
  it('names the home page', () => {
    expect(crumbsFor('/')).toEqual([{ label: 'Home' }]);
  });

  it('shows the object on list pages', () => {
    expect(crumbsFor('/jobs')).toEqual([{ label: 'Jobs', href: '/jobs' }]);
  });

  it('appends the decoded record id on record pages', () => {
    expect(crumbsFor('/workflows/market.ats%2Frefresh')).toEqual([
      { label: 'Workflows', href: '/workflows' },
      { label: 'market.ats/refresh', mono: true },
    ]);
  });

  it('labels fixed pages and settings', () => {
    expect(crumbsFor('/sources/new').at(-1)).toEqual({ label: 'New source' });
    expect(crumbsFor('/settings/system').map((c) => c.label)).toEqual(['Settings', 'System status']);
    expect(crumbsFor('/capabilities').map((c) => c.label)).toEqual(['Settings', 'Capabilities']);
  });

  it('places provenance leaves under their parent object', () => {
    expect(crumbsFor('/node-runs/nrun_1').map((c) => c.label)).toEqual(['Runs', 'Node run', 'nrun_1']);
    expect(crumbsFor('/snapshots/snap_1')[0]).toEqual({ label: 'Sources', href: '/sources' });
  });

  it('nests the import pages under Imports and New import', () => {
    expect(crumbsFor('/imports')).toEqual([{ label: 'Imports', href: '/imports' }]);
    expect(crumbsFor('/imports/new/companies')).toEqual([
      { label: 'Imports', href: '/imports' },
      { label: 'New import', href: '/imports/new' },
      { label: 'Companies' },
    ]);
    expect(crumbsFor('/imports/new/jobs')).toEqual([
      { label: 'Imports', href: '/imports' },
      { label: 'New import', href: '/imports/new' },
      { label: 'Job links' },
    ]);
    expect(crumbsFor('/imports/imp_1').map((c) => c.label)).toEqual(['Imports', 'imp_1']);
  });

  it('returns nothing for unknown routes', () => {
    expect(crumbsFor('/no-such-page')).toEqual([]);
  });
});
