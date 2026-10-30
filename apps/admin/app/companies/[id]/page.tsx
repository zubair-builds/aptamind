import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, StatusBadge } from '@/components/Badge';
import { DataTable } from '@/components/DataTable';
import { EvidenceList } from '@/components/EvidenceList';
import { ConflictFields } from '@/components/records/facts/ConflictFields';
import { FactGroup, FactProperty } from '@/components/records/facts/FactProperty';
import { JsonView } from '@/components/Json';
import { CompanyLink, ExternalLink, sourceNames, WorkflowLink } from '@/components/links';
import { KV, PageHeader, Section } from '@/components/Section';
import { AuditTable, JobsTable, ObservationsTable, ReviewTable } from '@/components/tables';
import { RelTime } from '@/components/Time';
import { discoverCareersAction, reconcileCompanyAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { fmtLocation, fmtNum, humanize } from '@/lib/format';
import type { CompanyDetail, Licence, Location } from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Company ${id}` };
}

function Urls({ urls }: { urls: string[] }) {
  return (
    <>
      {urls.map((u, i) => (
        <div key={i}>
          <ExternalLink href={u} />
        </div>
      ))}
    </>
  );
}

export default async function CompanyDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<CompanyDetail>(`/api/companies/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Company" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const {
    company: requested,
    survivor,
    observations,
    observationSources,
    jobs,
    jobSources,
    reviews,
    audit,
  } = res.data;
  // When the requested company was merged, show the surviving canonical record.
  const c = survivor ?? requested;
  const names = sourceNames([...observationSources, ...jobSources]);
  const path = `/companies/${seg(id)}`;
  const sp = c.employment.sponsorship;
  const openReviews = reviews.filter((r) => r.status === 'open');
  const name = c.identity.displayName.value ?? c.identity.normalizedName;

  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          <>
            <code className="id">{c._id}</code>
            <StatusBadge value={c.status} />
            <ConflictFields record={c} fields={c.quality.conflictFields} />
            {openReviews.length ? <Badge tone="warn">{openReviews.length} open review(s)</Badge> : null}
          </>
        }
        actions={
          <>
            <ActionForm
              action={discoverCareersAction}
              submitLabel="Discover careers"
              variant="primary"
              inline
              hidden={{ companyId: c._id, revalidate: path }}
            />
            <ActionForm
              action={reconcileCompanyAction}
              submitLabel="Reconcile"
              inline
              hidden={{ companyId: c._id, revalidate: path }}
            />
          </>
        }
      />
      {survivor ? (
        <div className="panel panel-info">
          <CompanyLink id={requested._id} /> was merged into{' '}
          <CompanyLink id={survivor._id}>{name}</CompanyLink>; showing the surviving company.
        </div>
      ) : null}

      <div className="grid-2">
        <Section title="Quality & freshness" id="quality">
          <KV
            items={[
              ['Observations', fmtNum(c.quality.observationCount)],
              ['Sources', fmtNum(c.quality.sourceIds.length)],
              [
                'Conflict fields',
                c.quality.conflictFields.length ? (
                  <ConflictFields record={c} fields={c.quality.conflictFields} variant="text" />
                ) : (
                  'none'
                ),
              ],
              ['Open reviews', c.quality.openReviewCount],
              ['Last observed', <RelTime key="o" iso={c.quality.lastObservedAt} abs />],
              ['Last reconciled', <RelTime key="r" iso={c.freshness.lastReconciledAt} abs />],
              ['Last changed', <RelTime key="c" iso={c.freshness.lastChangedAt} abs />],
              [
                'Careers discovery',
                <>
                  <StatusBadge value={c.freshness.careersDiscoveryStatus} /> checked{' '}
                  <RelTime iso={c.freshness.careersCheckedAt} />
                </>,
              ],
              c.reconciliation
                ? [
                    'Reconciliation',
                    `logic ${c.reconciliation.logicVersion} · policy ${c.reconciliation.policyVersion} · ${c.reconciliation.computedAt.slice(0, 19)}Z`,
                  ]
                : null,
              ['Created', <RelTime key="cr" iso={c.createdAt} abs />],
            ]}
          />
        </Section>
        <Section title="Identity details" id="identity-details">
          <KV
            items={[
              ['Normalized name', <code key="n">{c.identity.normalizedName}</code>],
              [
                'Aliases',
                c.identity.aliases.length ? (
                  <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
                    {c.identity.aliases.map((a) => (
                      <li key={a.strictKey}>
                        {a.name}{' '}
                        <span className="muted">
                          ({a.sourceIds.length} source{a.sourceIds.length === 1 ? '' : 's'})
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null,
              ],
              [
                'External ids',
                c.identity.externalIds.length
                  ? c.identity.externalIds.map((x) => `${x.namespace}:${x.id}`).join(', ')
                  : null,
              ],
              [
                'Declared distinct from',
                c.identity.distinctFrom?.length
                  ? c.identity.distinctFrom.map((d) => <CompanyLink key={d} id={d} />)
                  : null,
              ],
              [
                'Offices',
                c.geography.offices.length
                  ? c.geography.offices.map((o: Location) => fmtLocation(o)).join(' · ')
                  : null,
              ],
              [
                'Registered locations',
                c.geography.registeredLocations.length
                  ? c.geography.registeredLocations.map((o) => fmtLocation(o)).join(' · ')
                  : null,
              ],
            ]}
          />
        </Section>
      </div>

      <Section
        title="Canonical facts"
        id="facts"
        description="Each value with its status and confidence; the sources button lists the evidence down to the observation and raw artifact."
      >
        <FactGroup>
          <FactProperty
            label="Display name"
            fact={c.identity.displayName}
            sources={names}
            operatorHref="#audit"
          />
          <FactProperty
            label="Legal name"
            fact={c.identity.legalName}
            sources={names}
            operatorHref="#audit"
          />
          <FactProperty label="Domain" fact={c.identity.domain} sources={names} operatorHref="#audit" />
          <FactProperty
            label="Website"
            fact={c.identity.website}
            sources={names}
            operatorHref="#audit"
            render={(v) => <ExternalLink href={v} />}
          />
          <FactProperty
            label="Headquarters"
            fact={c.geography.headquarters}
            sources={names}
            operatorHref="#audit"
            render={(v) => fmtLocation(v)}
          />
          <FactProperty
            label="Hiring countries"
            fact={c.geography.hiringCountries}
            sources={names}
            operatorHref="#audit"
          />
          <FactProperty
            label="Careers URLs"
            fact={c.employment.careersUrls}
            sources={names}
            operatorHref="#audit"
            render={(v) => <Urls urls={v} />}
          />
          <FactProperty
            label="ATS"
            fact={c.employment.ats}
            sources={names}
            operatorHref="#audit"
            render={(v) => v.map((a) => `${a.provider}:${a.boardToken}`).join(', ') || '(none)'}
          />
          <FactProperty
            label="Remote policy"
            fact={c.employment.remotePolicy}
            sources={names}
            operatorHref="#audit"
          />
          <FactProperty
            label="Relocation support"
            fact={c.employment.relocationSupport}
            sources={names}
            operatorHref="#audit"
          />
          <FactProperty
            label="EOR indicators"
            fact={c.employment.eorIndicators}
            sources={names}
            operatorHref="#audit"
          />
          {c.classification ? (
            <>
              <FactProperty
                label="Industries"
                fact={c.classification.industries}
                sources={names}
                operatorHref="#audit"
              />
              <FactProperty
                label="Stage"
                fact={c.classification.stage}
                sources={names}
                operatorHref="#audit"
                render={(v) => humanize(v)}
              />
              <FactProperty
                label="Business model"
                fact={c.classification.businessModel}
                sources={names}
                operatorHref="#audit"
              />
            </>
          ) : null}
          {c.firmographics ? (
            <>
              <FactProperty
                label="Founded"
                fact={c.firmographics.foundedYear}
                sources={names}
                operatorHref="#audit"
              />
              <FactProperty
                label="Employees (estimate)"
                fact={c.firmographics.employeeEstimate}
                sources={names}
                operatorHref="#audit"
                render={(v) => fmtNum(v)}
              />
              <FactProperty
                label="Employee range"
                fact={c.firmographics.employeeRange}
                sources={names}
                operatorHref="#audit"
                render={(v) => `${v.min ?? '?'}–${v.max ?? '?'}`}
              />
              <FactProperty
                label="Funding stage"
                fact={c.firmographics.fundingStage}
                sources={names}
                operatorHref="#audit"
              />
            </>
          ) : null}
        </FactGroup>
        {c.classification?.schemes?.length ? (
          <details>
            <summary>Classification schemes ({c.classification.schemes.length})</summary>
            <JsonView value={c.classification.schemes} label="schemes" open />
          </details>
        ) : null}
      </Section>

      <Section
        title="Sponsor capability (company-level)"
        id="sponsorship"
        description="This is the COMPANY's licence to sponsor visas (e.g. UK Home Office register). It never implies that any specific job offers sponsorship — see each job's role statement."
      >
        <FactGroup>
          <FactProperty
            label="Company sponsor capability"
            fact={sp.capability}
            sources={names}
            operatorHref="#audit"
            render={(v) => <StatusBadge value={v} />}
          />
        </FactGroup>
        <p className="small">
          Licence countries:{' '}
          <strong>{sp.licenceCountries.length ? sp.licenceCountries.join(', ') : 'none'}</strong>
        </p>
        <DataTable<Licence>
          caption="Sponsor licences"
          rows={sp.licences}
          rowKey={(l, i) => `${l.register}-${l.route}-${i}`}
          empty="No sponsor licences on record."
          columns={[
            { key: 'reg', header: 'Register', cell: (l) => <code className="small">{l.register}</code> },
            { key: 'country', header: 'Country', cell: (l) => l.country },
            { key: 'route', header: 'Route', cell: (l) => l.route },
            {
              key: 'rating',
              header: 'Type / rating',
              cell: (l) => l.typeRating ?? <span className="muted">—</span>,
            },
            { key: 'status', header: 'Status', cell: (l) => <StatusBadge value={l.status} /> },
            { key: 'first', header: 'First seen', cell: (l) => <RelTime iso={l.firstSeenAt} /> },
            { key: 'last', header: 'Last seen', cell: (l) => <RelTime iso={l.lastSeenAt} /> },
            {
              key: 'ev',
              header: 'Evidence',
              cell: (l) =>
                l.evidence.length ? (
                  <details>
                    <summary>{l.evidence.length} ref(s)</summary>
                    <EvidenceList evidence={l.evidence} sources={names} />
                  </details>
                ) : (
                  <span className="muted">—</span>
                ),
            },
          ]}
        />
      </Section>

      <Section
        title={`Observations (${observations.length})`}
        id="observations"
        description="Statements sources made about this company (latest 100)."
      >
        <ObservationsTable observations={observations} sources={names} />
      </Section>

      <Section
        title={`Jobs (${jobs.length})`}
        id="jobs"
        actions={
          <Link href={`/jobs?companyId=${seg(c._id)}`} className="small">
            All jobs →
          </Link>
        }
      >
        <JobsTable jobs={jobs} showCompany={false} />
      </Section>

      <Section title={`Job sources (${jobSources.length})`} id="job-sources">
        <DataTable
          caption="Job sources"
          rows={jobSources}
          rowKey={(s) => s._id}
          empty="No job sources (ATS boards / careers pages) registered for this company."
          columns={[
            {
              key: 'name',
              header: 'Source',
              cell: (s) => (
                <Link href={`/sources/${seg(s._id)}`}>
                  <strong>{s.name}</strong> <span className="mono small muted">{s.key}</span>
                </Link>
              ),
            },
            { key: 'prov', header: 'Provider', cell: (s) => s.provider },
            { key: 'wf', header: 'Workflow', cell: (s) => <WorkflowLink id={s.acquisition.workflowKey} /> },
            {
              key: 'en',
              header: 'Enabled',
              cell: (s) => <StatusBadge value={s.enabled ? 'enabled' : 'disabled'} />,
            },
            { key: 'health', header: 'Health', cell: (s) => <StatusBadge value={s.health.status} /> },
            { key: 'succ', header: 'Last success', cell: (s) => <RelTime iso={s.health.lastSuccessAt} /> },
            { key: 'items', header: 'Items', numeric: true, cell: (s) => s.health.lastItemCount ?? '—' },
          ]}
        />
      </Section>

      <div className="grid-2">
        <Section title={`Reviews (${reviews.length}, ${openReviews.length} open)`} id="reviews">
          <ReviewTable items={reviews} />
        </Section>
        <Section title="Audit" id="audit">
          <AuditTable events={audit} />
        </Section>
      </div>
    </>
  );
}
