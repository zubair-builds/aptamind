import { describe, expect, it } from 'vitest';
import { companyCareersDiscovery, ukSponsorImport } from './index';

describe('wave 7: UK register import short-circuits an unchanged, applied file', () => {
  it('routes after the download; only the import branch reaches parse; both paths join the report (run output)', () => {
    const edges = ukSponsorImport.edges ?? [];
    expect(edges).toContainEqual({ from: 'download', to: 'unchanged' });
    expect(edges).toContainEqual({ from: 'unchanged', to: 'route' });
    expect(edges).toContainEqual({ from: 'route', to: 'parse', when: { branch: 'import' } });
    expect(edges.some((e) => e.from === 'download' && e.to === 'parse')).toBe(false);
    const check = ukSponsorImport.nodes.find((n) => n.id === 'unchanged')!;
    expect(JSON.stringify(check.input)).toContain('nodes.download.output.reprocessing');
    const sinks = ukSponsorImport.nodes.filter((n) => !edges.some((e) => e.from === n.id));
    expect(sinks.map((n) => n.id)).toEqual(['report']);
    expect(ukSponsorImport.outputNode).toBe('report');
    expect(edges).toContainEqual({ from: 'finalize', to: 'report' });
    expect(edges).toContainEqual({ from: 'route', to: 'report', when: { branch: 'unchanged' } });
    expect(JSON.stringify(check.input)).toContain('nodes.trigger.output.payload.force');
  });
});

describe('wave 6: careers discovery registers a careers page when no ATS is found', () => {
  it('runs the fallback from the discovery output, beside the ATS registration', () => {
    const node = companyCareersDiscovery.nodes.find((n) => n.id === 'careers_page')!;
    expect(node.capability).toEqual({ type: 'market.register_careers_page_fallback', version: 1 });
    const input = JSON.stringify(node.input);
    expect(input).toContain('nodes.discover.output.careersUrl');
    expect(input).toContain('nodes.discover.output.ats');
    expect(companyCareersDiscovery.edges ?? []).toContainEqual({ from: 'discover', to: 'careers_page' });
    expect(companyCareersDiscovery.outputNode).toBe('discover');
  });
});
