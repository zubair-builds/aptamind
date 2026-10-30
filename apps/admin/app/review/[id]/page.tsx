import type { ReactNode } from 'react';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, StatusBadge } from '@/components/Badge';
import { EvidenceList } from '@/components/EvidenceList';
import { JsonView } from '@/components/Json';
import { EntityLink, sourceNames } from '@/components/links';
import { KV, PageHeader, Section } from '@/components/Section';
import { AuditTable, ObservationsTable } from '@/components/tables';
import { RelTime } from '@/components/Time';
import { resolveReviewAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { fmtLocation, fmtValue, humanize } from '@/lib/format';
import type {
  Fact,
  JsonObject,
  Observation,
  PartialCompany,
  PartialJob,
  ReviewAction,
  ReviewDetail,
  Source,
} from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Review ${id}` };
}

const ACTION_HELP: Record<ReviewAction, string> = {
  confirm: 'Accept the current automated outcome (no change).',
  correct: 'Set an operator value for a field (authority: operator).',
  merge: 'Merge into / attach to the selected candidate.',
  create_new: 'Create a new distinct entity from the observation(s).',
  keep_separate: 'Declare the entities distinct (suppresses repeat reviews).',
  reject: 'Reject the observation(s) as not usable.',
  retry: 'Re-run the source / reprocess the entity.',
  dismiss: 'Close without action.',
};

const CORRECTABLE: Record<string, string[]> = {
  job: ['workModel', 'remoteScope', 'sponsorship', 'relocation', 'compensation', 'employmentType'],
  company: ['identity.domain', 'identity.website', 'identity.displayName'],
};

type Rows = Record<string, ReactNode>;

function fv<T>(f: Fact<T> | undefined, render: (v: T) => ReactNode = (v) => fmtValue(v)): ReactNode {
  if (!f) return <span className="muted">—</span>;
  if (f.value === null || f.value === undefined) return <span className="muted">{f.status}</span>;
  return (
    <>
      {render(f.value)} {f.status === 'conflicting' ? <Badge tone="warn">conflicting</Badge> : null}
    </>
  );
}

function companyRows(c: PartialCompany): Rows {
  return {
    'Display name': fv(c.identity?.displayName),
    'Legal name': fv(c.identity?.legalName),
    'Normalized name': c.identity?.normalizedName ?? '—',
    Domain: fv(c.identity?.domain),
    Website: fv(c.identity?.website),
    'External ids': c.identity?.externalIds?.map((x) => `${x.namespace}:${x.id}`).join(', ') || '—',
    Headquarters: fv(c.geography?.headquarters, (v) => fmtLocation(v)),
    'Sponsor capability': fv(c.employment?.sponsorship?.capability),
    'Licence countries': c.employment?.sponsorship?.licenceCountries?.join(', ') || '—',
    Licences: c.employment?.sponsorship?.licences?.map((l) => `${l.route} (${l.status})`).join('; ') || '—',
    Observations: c.quality?.observationCount ?? '—',
    'Conflict fields': c.quality?.conflictFields?.join(', ') || '—',
  };
}

function jobRows(j: PartialJob): Rows {
  return {
    Title: fv(j.identity?.title),
    'Normalized title': j.identity?.normalizedTitle ?? '—',
    Seniority: fv(j.identity?.seniority),
    Company: j.companyId ? <EntityLink kind="company" id={j.companyId} /> : '—',
    Locations:
      j.geography?.normalizedLocations?.map((l) => fmtLocation(l)).join(' · ') ||
      j.geography?.listedLocations?.join(' · ') ||
      '—',
    'Work model': fv(j.geography?.workModel),
    'Remote scope': fv(j.geography?.remoteScope, (v) => humanize(v.type)),
    Lifecycle: j.lifecycle ? <StatusBadge value={j.lifecycle.state} /> : '—',
    'First seen': j.lifecycle ? <RelTime iso={j.lifecycle.firstSeenAt} /> : '—',
    'Source copies':
      j.sourceRefs?.map((r) => `${r.provider}:${r.externalId}${r.present ? '' : ' (absent)'}`).join(', ') ||
      '—',
    'Posting URL': j.sourceRefs?.find((r) => r.postingUrl)?.postingUrl ?? '—',
  };
}

function observationRows(o: Observation, kind: 'company' | 'job'): Rows {
  const p = o.payload as JsonObject;
  const loc = Array.isArray(p.locations) ? (p.locations as Array<Record<string, string | null>>) : [];
  if (kind === 'company') {
    const lic = p.sponsorLicence as Record<string, unknown> | null | undefined;
    return {
      'Display name': fmtValue(p.name),
      'Legal name': fmtValue(p.legalName),
      Domain: fmtValue(p.domain),
      Website: fmtValue(p.website),
      'External ids': Array.isArray(p.externalIds)
        ? (p.externalIds as Array<{ namespace: string; id: string }>)
            .map((x) => `${x.namespace}:${x.id}`)
            .join(', ') || '—'
        : '—',
      Headquarters: loc[0] ? fmtLocation(loc[0]) : '—',
      'Sponsor capability': lic ? 'licensed (observed)' : '—',
      'Licence countries': lic ? fmtValue(lic.country) : '—',
      Licences: lic ? `${fmtValue(lic.route)} ${lic.typeRating ? `(${fmtValue(lic.typeRating)})` : ''}` : '—',
    };
  }
  return {
    Title: fmtValue(p.title),
    Company: fmtValue(p.companyName),
    Locations: loc.map((l) => fmtLocation(l)).join(' · ') || '—',
    'Work model': fmtValue(p.workplaceType),
    'Posting URL': fmtValue(p.postingUrl),
  };
}

function isSource(e: unknown): e is Source {
  return !!e && typeof e === 'object' && 'acquisition' in e && 'health' in e;
}

function CompareTable({ columns }: { columns: Array<{ heading: ReactNode; rows: Rows }> }) {
  const labels = [...new Set(columns.flatMap((c) => Object.keys(c.rows)))];
  return (
    <div
      className="table-wrap"
      role="region"
      aria-label="Entity under review compared with candidates"
      tabIndex={0}
    >
      <table className="table compare">
        <caption className="sr-only">Entity under review compared with candidates</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            {columns.map((c, i) => (
              <th key={i} scope="col">
                {c.heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l) => {
            const values = columns.map((c) => c.rows[l]);
            const texts = values.map((v) =>
              typeof v === 'string' || typeof v === 'number' ? String(v) : null,
            );
            const differs = texts.every((t) => t !== null) && new Set(texts).size > 1;
            return (
              <tr key={l} className={differs ? 'row-warn' : undefined}>
                <th scope="row">{l}</th>
                {values.map((v, i) => (
                  <td key={i}>{v ?? <span className="muted">—</span>}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function ReviewDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<ReviewDetail>(`/api/review/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Review item" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const { item, entity, observations, candidates, audit } = res.data;
  const path = `/review/${seg(item._id)}`;
  const obsKind: 'company' | 'job' = observations[0]?._id.startsWith('cobs_') ? 'company' : 'job';

  // Column 0: the entity under review (or the unresolved observation), then each candidate.
  const subjectColumn: { heading: ReactNode; rows: Rows } | null =
    entity && item.entity.kind === 'company'
      ? {
          heading: (
            <>
              Under review: company <EntityLink kind="company" id={item.entity.id} />
            </>
          ),
          rows: companyRows(entity as PartialCompany),
        }
      : entity && item.entity.kind === 'job'
        ? {
            heading: (
              <>
                Under review: job <EntityLink kind="job" id={item.entity.id} />
              </>
            ),
            rows: jobRows(entity as PartialJob),
          }
        : observations[0]
          ? {
              heading: (
                <>
                  Observation <EntityLink kind="observation" id={observations[0]._id} />
                </>
              ),
              rows: observationRows(observations[0], obsKind),
            }
          : null;
  const candidateColumns = candidates.map((c) => ({
    heading: (
      <>
        Candidate {c.kind} <EntityLink kind={c.kind} id={c.id} />
        <div className="small muted">
          {c.label}
          {typeof c.score === 'number' ? ` · score ${c.score.toFixed(2)}` : ''}
        </div>
      </>
    ),
    rows: c.entity
      ? c.kind === 'company'
        ? companyRows(c.entity as PartialCompany)
        : jobRows(c.entity as PartialJob)
      : { Missing: 'entity not found' },
  }));
  const compare = [subjectColumn, ...candidateColumns].filter(
    (c): c is { heading: ReactNode; rows: Rows } => !!c,
  );
  const fields = CORRECTABLE[item.entity.kind] ?? [];

  return (
    <>
      <PageHeader
        title={item.subject}
        subtitle={
          <>
            <code className="id">{item._id}</code>
            <StatusBadge value={item.status} />
            <StatusBadge value={item.severity} kind="severity" label={`${item.severity} severity`} />
            <Badge tone="muted">{humanize(item.type)}</Badge>
            <span className="small">priority {item.priority}</span>
          </>
        }
      />

      <div className="grid-2">
        <Section title="Item" id="item">
          <KV
            items={[
              ['Type', humanize(item.type)],
              ['Reason', item.reason],
              [
                'Entity',
                <>
                  {item.entity.kind} <EntityLink kind={item.entity.kind} id={item.entity.id} />
                </>,
              ],
              ['Occurrences', item.occurrences],
              ['Created', <RelTime key="c" iso={item.createdAt} abs />],
              ['Updated', <RelTime key="u" iso={item.updatedAt} abs />],
              ['Allowed actions', item.allowedActions.join(', ')],
              [
                'Dedupe key',
                <code key="d" className="small">
                  {item.dedupeKey}
                </code>,
              ],
              ['Context', <JsonView key="x" value={item.context} label="context" open />],
            ]}
          />
        </Section>
        <Section title={item.status === 'open' ? 'Resolve' : 'Resolution'} id="resolve">
          {item.status === 'open' ? (
            <ActionForm
              action={resolveReviewAction}
              submitLabel="Submit decision"
              variant="primary"
              hidden={{ reviewId: item._id, revalidate: path }}
            >
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="muted">Action</legend>
                {item.allowedActions.map((a, i) => (
                  <label key={a} className="field-check field">
                    <input type="radio" name="action" value={a} defaultChecked={i === 0} required />{' '}
                    <strong>{humanize(a)}</strong> <span className="muted small">— {ACTION_HELP[a]}</span>
                  </label>
                ))}
              </fieldset>
              {item.allowedActions.includes('merge') || item.allowedActions.includes('keep_separate') ? (
                <label className="field">
                  <span>Target (for merge / keep separate)</span>
                  <select name="targetId" defaultValue="">
                    <option value="">
                      {candidates.length === 1 ? '(the single candidate)' : '— choose a candidate —'}
                    </option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} ({c.id})
                        {typeof c.score === 'number' ? ` · score ${c.score.toFixed(2)}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {item.allowedActions.includes('correct') ? (
                <>
                  <label className="field">
                    <span>Field (for correct)</span>
                    <input
                      type="text"
                      name="field"
                      list="correct-fields"
                      placeholder={fields[0] ?? 'field'}
                    />
                    <datalist id="correct-fields">
                      {fields.map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                  </label>
                  <label className="field">
                    <span>Value (JSON, for correct — e.g. &quot;remote&quot; or an object)</span>
                    <textarea name="value" rows={4} spellCheck={false} placeholder='"remote"' />
                  </label>
                </>
              ) : null}
              <label className="field">
                <span>Reason (required, min 3 characters)</span>
                <textarea
                  name="reason"
                  rows={3}
                  required
                  minLength={3}
                  maxLength={2000}
                  style={{ fontFamily: 'inherit' }}
                />
              </label>
            </ActionForm>
          ) : item.resolution ? (
            <KV
              items={[
                [
                  'Action',
                  <Badge key="a" tone="info">
                    {humanize(item.resolution.action)}
                  </Badge>,
                ],
                ['Reason', item.resolution.reason],
                ['By', `${item.resolution.actor.kind}:${item.resolution.actor.id}`],
                ['At', <RelTime key="at" iso={item.resolution.at} abs />],
                ['Target', item.resolution.targetId ? <code>{item.resolution.targetId}</code> : null],
                [
                  'Value',
                  item.resolution.value !== undefined ? (
                    <JsonView value={item.resolution.value} label="value" open />
                  ) : null,
                ],
                [
                  'Result',
                  item.resolution.result ? (
                    <JsonView value={item.resolution.result} label="result" open />
                  ) : null,
                ],
              ]}
            />
          ) : (
            <p className="empty">No resolution recorded.</p>
          )}
        </Section>
      </div>

      <Section
        title="Side-by-side comparison"
        id="compare"
        description="Rows whose plain values differ are highlighted."
      >
        {compare.length ? <CompareTable columns={compare} /> : <p className="empty">Nothing to compare.</p>}
        {entity && isSource(entity) ? (
          <p className="small">
            Source under review: <EntityLink kind="source" id={entity._id} /> ({entity.key}) — health{' '}
            <StatusBadge value={entity.health.status} />
            {entity.health.lastError ? <span className="text-bad"> · {entity.health.lastError}</span> : null}
          </p>
        ) : null}
        {entity ? <JsonView value={entity} label="Full entity under review (JSON)" /> : null}
      </Section>

      <Section title={`Evidence (${item.evidence.length})`} id="evidence">
        <EvidenceList evidence={item.evidence} sources={sourceNames([])} />
      </Section>

      <Section title={`Observations (${observations.length})`} id="observations">
        <ObservationsTable observations={observations} />
        {observations.map((o) => (
          <JsonView key={o._id} value={o.payload} label={`payload of ${o._id}`} />
        ))}
      </Section>

      <Section title="Audit" id="audit">
        <AuditTable events={audit} />
      </Section>
    </>
  );
}
