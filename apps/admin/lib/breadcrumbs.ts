/** Breadcrumbs derived from the URL only (presentation; no data fetching). */

export interface Crumb {
  label: string;
  href?: string;
  /** Record ids are shown in monospace. */
  mono?: boolean;
}

const SETTINGS: Crumb = { label: 'Settings' };

/** Object crumb(s) per first path segment. */
const OBJECTS: Record<string, Crumb[]> = {
  review: [{ label: 'Review', href: '/review' }],
  companies: [{ label: 'Companies', href: '/companies' }],
  jobs: [{ label: 'Jobs', href: '/jobs' }],
  sources: [{ label: 'Sources', href: '/sources' }],
  imports: [{ label: 'Imports', href: '/imports' }],
  snapshots: [{ label: 'Sources', href: '/sources' }, { label: 'Snapshot' }],
  observations: [{ label: 'Observation' }],
  workflows: [{ label: 'Workflows', href: '/workflows' }],
  runs: [{ label: 'Runs', href: '/runs' }],
  'node-runs': [{ label: 'Runs', href: '/runs' }, { label: 'Node run' }],
  capabilities: [SETTINGS, { label: 'Capabilities', href: '/capabilities' }],
};

const NEW_IMPORT: Crumb = { label: 'New import', href: '/imports/new' };

const PAGES: Record<string, Crumb | Crumb[]> = {
  'sources/new': { label: 'New source' },
  'imports/new': { label: 'New import' },
  'imports/new/companies': [NEW_IMPORT, { label: 'Companies' }],
  'imports/new/ats-boards': [NEW_IMPORT, { label: 'Known ATS boards' }],
  'imports/new/snapshot': [NEW_IMPORT, { label: 'Source snapshot' }],
  'settings/system': { label: 'System status' },
  'settings/ui': { label: 'UI catalogue' },
};

function decode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function crumbsFor(pathname: string): Crumb[] {
  const segs = pathname.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (!segs.length) return [{ label: 'Home' }];
  const page = PAGES[segs.join('/')];
  if (segs[0] === 'settings') return page ? [SETTINGS, ...[page].flat()] : [SETTINGS];
  const object = OBJECTS[segs[0]!];
  if (!object) return [];
  if (page) return [...object, ...[page].flat()];
  if (segs.length === 1) return object;
  return [...object, { label: decode(segs[1]!), mono: true }];
}
