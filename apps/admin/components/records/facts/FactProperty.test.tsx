// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceLink, sourceNames } from '@/components/links';
import { ConfidenceIndicator } from '@/components/ui/ConfidenceIndicator';
import { toneFor } from '@/lib/tones';
import type { Evidence, Fact, SummaryFact } from '@/lib/types';
import { FactGroup, FactProperty } from './FactProperty';
import { FactSummary } from './FactSummary';
import { ConflictFields, splitConflictFields } from './ConflictFields';
import { SponsorshipValue } from '@/components/SponsorshipValue';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
afterEach(cleanup);

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  sourceId: 'src_ats',
  observationId: 'jobs_1',
  snapshotId: 'snap_1',
  artifactId: 'art_1',
  locator: 'jobs/1#description[10:42]',
  quote: 'Fully remote within the EU',
  observedAt: '2026-09-29T10:00:00Z',
  authority: 'official_ats',
  extractor: { name: 'workmodel.rules', version: '3' },
  ...over,
});

const fact = <T,>(over: Partial<Fact<T>>): Fact<T> => ({
  value: null,
  status: 'known',
  confidence: { level: 'high', score: 0.92, reasons: ['description.explicit'] },
  evidence: [ev()],
  conflicts: [],
  policyVersion: 'job-policy/1',
  updatedAt: '2026-09-29T11:00:00Z',
  ...over,
});

const sources = sourceNames([
  { _id: 'src_ats', name: 'Acme (greenhouse)' },
  { _id: 'src_feed', name: 'JobHub feed' },
]);

function renderFact<T>(
  f: Fact<T> | null,
  extra: { render?: (v: T) => ReactNode; variant?: 'full' | 'compact' } = {},
) {
  return render(
    <FactGroup>
      <FactProperty label="Work model" fact={f} sources={sources} {...extra} />
    </FactGroup>,
  );
}

const row = () => screen.getByText('Work model').parentElement!;

describe('FactProperty', () => {
  it('known: shows the value as returned, confidence and a sources button — no status noise', () => {
    renderFact(fact({ value: 'remote' }));
    expect(within(row()).getByText('remote')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Confidence: high, score 0.92' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 source for Work model' })).toBeTruthy();
    expect(within(row()).getByText('High')).toBeTruthy(); // confidence as a visible word, sentence case
    expect(screen.queryByText(/disagree/)).toBeNull();
    expect(screen.queryByText(/other value/)).toBeNull();
  });

  it('reaches source → observation → snapshot → artifact in two clicks', () => {
    renderFact(fact({ value: 'remote' }));
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    const panel = screen.getByRole('dialog', { name: 'Provenance: Work model' });
    const p = within(panel);
    expect(p.getByRole('link', { name: 'Acme (greenhouse)' }).getAttribute('href')).toBe('/sources/src_ats');
    expect(p.getByRole('link', { name: 'Observation' }).getAttribute('href')).toBe('/observations/jobs_1');
    expect(p.getByRole('link', { name: 'Snapshot' }).getAttribute('href')).toBe('/snapshots/snap_1');
    const artifact = p.getByRole('link', { name: 'Artifact (opens in a new tab)' });
    expect(artifact.getAttribute('href')).toBe('/artifacts/art_1');
    expect(p.getByText('Fully remote within the EU')).toBeTruthy();
    expect(p.getByText('jobs/1#description[10:42]')).toBeTruthy();
    expect(panel.textContent).toContain('basis: description.explicit');
    expect(panel.textContent).toContain('policy job-policy/1');
    expect(panel.textContent).toContain('via workmodel.rules@3');
  });

  it('unknown: says Unknown with the reason, never a guessed value', () => {
    renderFact(
      fact<string>({
        value: null,
        status: 'unknown',
        confidence: { level: 'unknown', reasons: ['no work model statement'] },
      }),
    );
    expect(within(row()).getByText('Unknown')).toBeTruthy();
    expect(within(row()).getByText('Basis: no work model statement')).toBeTruthy();
    // "Unknown" in words; no redundant unknown-confidence meter, the popover still states it.
    expect(screen.queryByRole('img', { name: /Confidence/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    expect(screen.getByRole('dialog').textContent).toContain('Confidence unknown');
  });

  it('conflicting: "Sources disagree · N" warning button opens the disagreeing values', () => {
    renderFact(
      fact({
        value: 'remote',
        status: 'conflicting',
        confidence: { level: 'low', reasons: ['sources disagree'] },
        conflicts: [
          {
            value: 'hybrid',
            reason: 'third-party feed says hybrid',
            evidence: [ev({ sourceId: 'src_feed' })],
          },
        ],
      }),
    );
    expect(within(row()).getByText('remote')).toBeTruthy();
    expect(screen.queryByText(/other value/)).toBeNull();
    const disagree = screen.getByRole('button', { name: 'Sources disagree · 1 on Work model' });
    fireEvent.click(disagree);
    const panel = within(screen.getByRole('dialog', { name: 'Sources disagree: Work model' }));
    expect(panel.getByText(/Disagreeing values/)).toBeTruthy();
    expect(panel.getByText('hybrid')).toBeTruthy();
    expect(panel.getByText('third-party feed says hybrid')).toBeTruthy();
    expect(panel.getByRole('link', { name: 'JobHub feed' })).toBeTruthy();
  });

  it('known with retained alternates: neutral "+N other values", never a conflict', () => {
    renderFact(
      fact({
        value: 'remote',
        conflicts: [
          {
            value: 'hybrid',
            reason: 'lower authority',
            evidence: [ev({ sourceId: 'src_feed', authority: 'third_party' })],
          },
          { value: 'onsite', reason: 'older', evidence: [] },
        ],
      }),
    );
    expect(screen.queryByText(/disagree/i)).toBeNull();
    const other = screen.getByRole('button', { name: '+2 other values for Work model' });
    fireEvent.click(other);
    const panel = within(screen.getByRole('dialog', { name: 'Other values: Work model' }));
    expect(panel.getByText('hybrid')).toBeTruthy();
    expect(panel.getByText('lower authority')).toBeTruthy();
    expect(panel.getByText('onsite')).toBeTruthy();
    expect(panel.getByText('No evidence recorded.')).toBeTruthy();
  });

  it('full: a known value with unknown confidence keeps the meter', () => {
    renderFact(fact({ value: 'remote', confidence: { level: 'unknown', reasons: [] } }));
    expect(screen.getByRole('img', { name: 'Confidence: unknown' })).toBeTruthy();
  });

  it('no evidence: plain text, not a button, and the basis moves inline', () => {
    renderFact(fact({ value: 'remote', evidence: [] }));
    expect(within(row()).getByText('No evidence').tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
    expect(within(row()).getByText('Basis: description.explicit')).toBeTruthy();
  });

  it('conflicting without evidence still opens the disagreeing values', () => {
    renderFact(
      fact({
        status: 'conflicting',
        value: null,
        evidence: [],
        conflicts: [{ value: 'hybrid', reason: 'feed', evidence: [] }],
      }),
    );
    expect(within(row()).getByText('No value')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sources disagree · 1 on Work model' }));
    expect(within(screen.getByRole('dialog')).getByText('hybrid')).toBeTruthy();
  });

  it('unknown with a value on record: "Unknown" stays the label, the value is secondary', () => {
    renderFact(
      fact<string>({
        value: 'onsite',
        status: 'unknown',
        confidence: { level: 'unknown', reasons: ['stale'] },
      }),
    );
    const main = row().querySelector('dd')!.firstElementChild!.firstElementChild!;
    expect(main.textContent).toBe('Unknown');
    expect(within(row()).getByText(/Value on record:/).textContent).toBe('Value on record: onsite');
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    expect(screen.getByRole('dialog').textContent).toContain('Status unknown · value on record: onsite');
  });

  it('an unrecognised status gets a neutral pill with the raw status, never shown as known', () => {
    renderFact(fact({ value: 'remote', status: 'expired' as Fact<string>['status'] }));
    const pill = within(row()).getByText('expired');
    expect(pill.dataset.tone).toBe('neutral');
    const main = row().querySelector('dd')!.firstElementChild!.firstElementChild!;
    expect(main.textContent).toBe('expired');
    expect(within(row()).getByText('Value on record: remote')).toBeTruthy();
  });

  it('a long quote is clamped with a control to read it in full', () => {
    const long = 'Fully remote within the EU. '.repeat(8).trim();
    renderFact(fact({ value: 'remote', evidence: [ev({ quote: long })] }));
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    const toggle = screen.getByRole('button', { name: 'Show full quote' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const quote = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(quote.textContent).toBe(long);
    expect(quote.hasAttribute('data-expanded')).toBe(false);
    fireEvent.click(toggle);
    expect(quote.hasAttribute('data-expanded')).toBe(true);
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('does not repeat "no evidence" as an inline reason next to "No evidence"', () => {
    renderFact(
      fact<string>({
        status: 'unknown',
        evidence: [],
        confidence: { level: 'unknown', reasons: ['no evidence'] },
      }),
    );
    expect(within(row()).getByText('Unknown')).toBeTruthy();
    expect(within(row()).queryByText(/no evidence$/)).toBeNull();
    expect(within(row()).getAllByText(/no evidence/i)).toHaveLength(1);
  });

  it('renders a missing fact as absent from the API response', () => {
    renderFact(null);
    expect(within(row()).getByText('Not in the API response')).toBeTruthy();
  });

  it('treats a literal "operator" source as the operator, not a source link', () => {
    renderFact(fact({ value: 'remote', evidence: [ev({ sourceId: 'operator', authority: 'operator' })] }));
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    const panel = within(screen.getByRole('dialog'));
    expect(panel.getByText('Operator')).toBeTruthy();
    expect(panel.queryByRole('link', { name: /operator/i })).toBeNull();
  });

  it('a recorded basis of "none" is not shown as "Basis: none"', () => {
    renderFact(
      fact<string>({ status: 'unknown', evidence: [], confidence: { level: 'unknown', reasons: ['none'] } }),
    );
    expect(within(row()).queryByText(/Basis/)).toBeNull();
    expect(within(row()).getByText('Unknown')).toBeTruthy();
  });

  it('the operator-override link moves focus to the target section (closing the popover)', () => {
    const target = document.createElement('section');
    target.id = 'conflicts';
    document.body.append(target);
    render(
      <FactGroup>
        <FactProperty
          label="Work model"
          fact={fact({ value: 'remote', evidence: [ev({ sourceId: 'operator', authority: 'operator' })] })}
          operatorHref="#conflicts"
        />
      </FactGroup>,
    );
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Operator override' }));
    expect(document.activeElement).toBe(target);
    expect(screen.queryByRole('dialog')).toBeNull();
    target.remove();
  });

  it('links operator-override evidence to the record trail when the page gives one', () => {
    render(
      <FactGroup>
        <FactProperty
          label="Work model"
          fact={fact({ value: 'remote', evidence: [ev({ sourceId: 'operator', authority: 'operator' })] })}
          operatorHref="#conflicts"
        />
      </FactGroup>,
    );
    fireEvent.click(screen.getByRole('button', { name: '1 source for Work model' }));
    const link = within(screen.getByRole('dialog')).getByRole('link', { name: 'Operator override' });
    expect(link.getAttribute('href')).toBe('#conflicts');
  });

  it('uses the page renderer for the value and keeps sponsorship exactly as returned', () => {
    renderFact(fact({ value: { status: 'company_capable' } }), {
      render: (v: { status: string }) => <span>{v.status}</span>,
    });
    expect(within(row()).getByText('company_capable')).toBeTruthy();
  });

  it('compact: hides high confidence and inline reasons, keeps low confidence visible', () => {
    const { unmount } = renderFact(fact({ value: 'remote' }), { variant: 'compact' });
    expect(screen.queryByRole('img', { name: /Confidence/ })).toBeNull();
    unmount();
    renderFact(fact({ value: 'remote', confidence: { level: 'low', reasons: ['weak'] } }), {
      variant: 'compact',
    });
    expect(screen.getByRole('img', { name: 'Confidence: low' })).toBeTruthy();
    expect(screen.queryByText('weak')).toBeNull();
  });
});

describe('FactProperty compact unknown', () => {
  it('keeps the reason for assistive tech and does not add a meter to Unknown', () => {
    renderFact(
      fact<string>({ status: 'unknown', confidence: { level: 'unknown', reasons: ['no statement'] } }),
      { variant: 'compact' },
    );
    expect(within(row()).getByText('Unknown').textContent).toBe('Unknown (basis: no statement)');
    expect(screen.queryByRole('img', { name: /Confidence/ })).toBeNull();
  });
});

describe('FactSummary', () => {
  const summary = <T,>(over: Partial<SummaryFact<T>>): SummaryFact<T> => ({
    value: null,
    status: 'known',
    confidence: { level: 'high' },
    ...over,
  });

  it('known (API v1, no basis/alternates): just the value', () => {
    const { container } = render(<FactSummary fact={summary({ value: 'remote' })} />);
    expect(container.textContent).toBe('remote');
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('known with alternates: a neutral +N, never a conflict pill', () => {
    const { container } = render(
      <FactSummary fact={summary({ value: 'remote', basis: 'provider.workplaceType', alternates: 2 })} />,
    );
    expect(screen.queryByText(/disagree/)).toBeNull();
    expect(container.textContent).toContain('+2 (2 other values kept)');
    expect(container.textContent).toContain('Basis: provider.workplaceType');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe('Basis: provider.workplaceType');
  });

  it('conflicting: "Sources disagree" warning pill (the API decided, not the UI)', () => {
    render(<FactSummary fact={summary({ value: 'remote', status: 'conflicting', alternates: 1 })} />);
    expect(screen.getByText('Sources disagree').dataset.tone).toBe('warning');
    expect(screen.queryByText(/\+1/)).toBeNull();
  });

  it('unknown: Unknown, even if a value is present; no meter', () => {
    render(
      <FactSummary
        fact={summary({ value: 'onsite', status: 'unknown', confidence: { level: 'unknown' } })}
      />,
    );
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.queryByText('onsite')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('low confidence shows the meter; a missing fact shows a dash', () => {
    const { unmount } = render(
      <FactSummary fact={summary({ value: 'hybrid', confidence: { level: 'low', score: 0.3 } })} />,
    );
    expect(screen.getByRole('img', { name: 'Confidence: low, score 0.30' })).toBeTruthy();
    unmount();
    const { container } = render(<FactSummary fact={undefined} />);
    expect(container.textContent).toBe('—');
  });

  it('v1 Fact without `alternates`: the count is the length of conflicts[]', () => {
    const { container } = render(
      <FactSummary
        fact={fact({ value: 'remote', conflicts: [{ value: 'hybrid', reason: 'x', evidence: [] }] })}
      />,
    );
    expect(container.textContent).toContain('+1 (1 other value kept)');
  });

  it('an unrecognised status is a neutral pill, never the value as known', () => {
    render(
      <FactSummary fact={summary({ value: 'remote', status: 'expired' as SummaryFact<string>['status'] })} />,
    );
    expect(screen.getByText('expired').dataset.tone).toBe('neutral');
    expect(screen.queryByText('remote')).toBeNull();
  });

  it('accepts a full v1 Fact and renders its value through the page renderer', () => {
    render(
      <FactSummary
        fact={fact({ value: { status: 'company_capable' } })}
        render={(v: { status: string }) => <span>{v.status}</span>}
      />,
    );
    expect(screen.getByText('company_capable')).toBeTruthy();
  });
});

describe('ConfidenceIndicator', () => {
  it.each([
    ['high', 3],
    ['medium', 2],
    ['low', 1],
    ['unknown', 0],
  ] as const)('%s fills %i of 3 segments', (level, filled) => {
    const { container } = render(<ConfidenceIndicator level={level} />);
    expect(container.querySelectorAll('[data-on]')).toHaveLength(filled);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`Confidence: ${level}`);
  });

  it('showLabel prints the level as a visible word', () => {
    const { container } = render(<ConfidenceIndicator level="medium" showLabel />);
    expect(container.textContent).toBe('Medium');
  });
});

describe('tone map', () => {
  it('marks conflicting facts as warning, not danger', () => {
    expect(toneFor('conflicting')).toBe('warning');
    expect(toneFor('known')).toBe('success');
  });
});

describe('ConflictFields', () => {
  const record = {
    geography: {
      remoteScope: fact({ value: 'country', conflicts: [{ value: 'worldwide', reason: 'x', evidence: [] }] }),
      workModel: fact({ value: 'remote', status: 'conflicting' }),
    },
  };

  it('labels each API conflict field by the fact status in the same response', () => {
    expect(
      splitConflictFields(record, ['geography.remoteScope', 'geography.workModel', 'identity.missing']),
    ).toEqual({
      disagree: ['geography.workModel', 'identity.missing'],
      otherValues: ['geography.remoteScope'],
    });
  });

  it('header badges say "Sources disagree" (warning) and "Flagged with other values" (neutral)', () => {
    const { container } = render(
      <ConflictFields record={record} fields={['geography.remoteScope', 'geography.workModel']} />,
    );
    expect(container.textContent).toContain('Sources disagree: work model');
    expect(container.textContent).toContain('Flagged with other values: remote scope');
    expect(container.querySelector('.badge-warn')?.textContent).toContain('Sources disagree');
    expect(container.querySelector('.badge-muted')?.textContent).toContain('Flagged with other values');
    // Not worded as a complete list: the tooltip points at the per-row counts.
    expect(container.querySelector('.badge-muted')?.getAttribute('title')).toMatch(
      /Other facts can keep alternates too/,
    );
  });

  it('count variant for table cells', () => {
    const { container } = render(
      <ConflictFields
        record={record}
        fields={['geography.remoteScope', 'geography.workModel']}
        variant="count"
      />,
    );
    expect(container.textContent).toBe(' · 1 field where sources disagree · 1 field with other values');
  });
});

describe('SponsorshipValue', () => {
  it('shows the role statement and the employer capability as separate axes', () => {
    const { container } = render(
      <SponsorshipValue
        v={{
          status: 'company_capable',
          roleStatement: 'none',
          companyCapability: 'licensed',
          capabilityCountries: ['GB'],
        }}
      />,
    );
    expect(container.textContent).toBe('Role says nothing · Employer holds a licence (GB)');
    expect(container.textContent).not.toMatch(/sponsors\b|Sponsors: yes/);
    expect(container.firstElementChild?.getAttribute('title')).toBe('API status: company capable');
  });

  it('an explicit role statement is the role', () => {
    const { container } = render(
      <SponsorshipValue
        v={{
          status: 'explicit_yes',
          roleStatement: 'yes',
          companyCapability: 'unknown',
          capabilityCountries: [],
        }}
      />,
    );
    expect(container.textContent).toBe('Role offers sponsorship · Employer: unknown');
  });

  it('says "Unclear" in words and always shows the employer axis', () => {
    const { container } = render(
      <SponsorshipValue
        v={{ status: 'unclear', roleStatement: 'none', companyCapability: 'none', capabilityCountries: [] }}
      />,
    );
    expect(container.textContent).toBe('Unclear Role says nothing · Employer: no licence on record');
  });
});

describe('source names', () => {
  it('never reads inherited properties for ids such as constructor', () => {
    render(<SourceLink id="constructor" names={sourceNames([])} />);
    expect(screen.getByRole('link').textContent).toBe('constructor');
  });
});
