import Link from 'next/link';
import { Fragment } from 'react';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, BoolBadge, StatusBadge } from '@/components/Badge';
import { DataTable } from '@/components/DataTable';
import { ConflictFields } from '@/components/records/facts/ConflictFields';
import { FactGroup, FactProperty } from '@/components/records/facts/FactProperty';
import { SponsorshipValue } from '@/components/SponsorshipValue';
import { JsonView, TextBlock } from '@/components/Json';
import {
  ArtifactLink,
  CompanyLink,
  ExternalLink,
  JobLink,
  ObservationLink,
  RunLink,
  SourceLink,
  sourceNames,
} from '@/components/links';
import { KV, PageHeader, Section } from '@/components/Section';
import { AuditTable, ObservationsTable, ReviewTable } from '@/components/tables';
import { RelTime } from '@/components/Time';
import { reinterpretJobAction, verifyJobAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { fmtDateTime, fmtLocation, fmtMoney, humanize, list } from '@/lib/format';
import type {
  Authorization,
  Compensation,
  EvidenceSpan,
  JobDetail,
  OfficeAttendance,
  RemoteScope,
  Requirement,
  Sponsorship,
} from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Job ${id}` };
}

function Spans({ spans }: { spans: EvidenceSpan[] }) {
  if (!spans.length) return <span className="muted">—</span>;
  return (
    <span className="small">
      {spans.map((s, i) => (
        <span key={i} className="quote">
          {i > 0 ? ' · ' : null}
          <q>{s.quote}</q> <span className="muted">({s.field})</span>
        </span>
      ))}
    </span>
  );
}

function RemoteScopeView({ v }: { v: RemoteScope }) {
  const tz = v.timezone;
  return (
    <span>
      <strong>{humanize(v.type)}</strong>
      {v.countries.length ? <> · countries {v.countries.join(', ')}</> : null}
      {v.regions.length ? <> · regions {v.regions.join(', ')}</> : null}
      {v.excludedCountries.length ? (
        <span className="text-bad"> · excluded countries {v.excludedCountries.join(', ')}</span>
      ) : null}
      {v.excludedRegions.length ? (
        <span className="text-bad"> · excluded regions {v.excludedRegions.join(', ')}</span>
      ) : null}
      {tz ? (
        <>
          {' '}
          · timezone UTC{tz.minUtcOffset ?? '?'}…UTC{tz.maxUtcOffset ?? '?'}{' '}
          <span className="muted">(“{tz.text}”)</span>
        </>
      ) : null}
    </span>
  );
}

function AttendanceView({ v }: { v: OfficeAttendance }) {
  return (
    <span>
      office required: {v.required === null ? 'unknown' : v.required ? 'yes' : 'no'}
      {v.daysPerWeek !== null ? <> · {v.daysPerWeek} day(s)/week</> : null}
      {v.officeLocations.length ? <> · {v.officeLocations.join(', ')}</> : null}
    </span>
  );
}

function AuthorizationView({ v }: { v: Authorization }) {
  return (
    <span>
      work authorization required: {v.required === null ? 'unknown' : v.required ? 'yes' : 'no'}
      {v.countries.length ? <> · {v.countries.join(', ')}</> : null}
      {v.qualifiers.length ? <> · {v.qualifiers.join(', ')}</> : null}
    </span>
  );
}

function CompensationView({ v }: { v: Compensation }) {
  const range =
    v.min === null && v.max === null
      ? null
      : `${fmtMoney(v.min, v.currency)} – ${fmtMoney(v.max, v.currency)}`;
  return (
    <div>
      <div>
        <StatusBadge value={v.status} />{' '}
        {range ? <strong>{range}</strong> : <span className="muted">no range</span>}
        {v.period ? <> per {v.period}</> : null} <span className="muted">· basis {humanize(v.basis)}</span>
      </div>
      {v.annualized ? (
        <div className="small">
          Annualized: {fmtMoney(v.annualized.min, v.currency)} – {fmtMoney(v.annualized.max, v.currency)}
          {v.annualized.assumptions.length ? (
            <span className="muted"> (assumptions: {v.annualized.assumptions.join('; ')})</span>
          ) : null}
        </div>
      ) : null}
      {v.originalText ? (
        <div className="small">
          Original: <q>{v.originalText}</q>
        </div>
      ) : null}
      {v.equityText ? <div className="small">Equity: {v.equityText}</div> : null}
      {v.bonusText ? <div className="small">Bonus: {v.bonusText}</div> : null}
      {v.warnings.length ? <div className="small text-warn">Warnings: {v.warnings.join('; ')}</div> : null}
    </div>
  );
}

const ROLE_LABEL: Record<Sponsorship['roleStatement'], string> = {
  yes: 'The job explicitly says it sponsors',
  no: 'The job explicitly says it does NOT sponsor',
  none: 'The job says nothing about sponsorship',
};

function SponsorshipPanel({
  fact,
  company,
}: {
  fact: JobDetail['job']['immigration']['sponsorship'];
  company: JobDetail['company'];
}) {
  const v = fact.value;
  return (
    <div className="two-col">
      <div className="callout">
        <h3>Role statement (this job)</h3>
        {v ? (
          <>
            <p>
              <Badge tone={v.roleStatement === 'yes' ? 'ok' : v.roleStatement === 'no' ? 'bad' : 'muted'}>
                {v.roleStatement}
              </Badge>{' '}
              {ROLE_LABEL[v.roleStatement]}
            </p>
            <p className="small">
              Resulting job status: <StatusBadge value={v.status} />
              {v.status === 'company_capable' ? (
                <span className="muted"> — capability only, NOT an explicit offer</span>
              ) : null}
            </p>
          </>
        ) : (
          <p className="muted">Unknown.</p>
        )}
      </div>
      <div className="callout">
        <h3>Company capability (employer licence)</h3>
        {v ? (
          <p>
            <Badge
              tone={
                v.companyCapability === 'licensed'
                  ? 'info'
                  : v.companyCapability === 'historical'
                    ? 'warn'
                    : 'muted'
              }
            >
              {v.companyCapability}
            </Badge>
            {v.capabilityCountries.length ? <> in {v.capabilityCountries.join(', ')}</> : null}
          </p>
        ) : null}
        <p className="small">
          Canonical company fact:{' '}
          {company.sponsorship.capability.value ? (
            <StatusBadge value={company.sponsorship.capability.value} />
          ) : (
            <span className="muted">none</span>
          )}{' '}
          {company.sponsorship.licenceCountries.length ? (
            <>({company.sponsorship.licenceCountries.join(', ')})</>
          ) : null}{' '}
          · <Link href={`/companies/${seg(company._id)}#sponsorship`}>licences →</Link>
        </p>
        <p className="small muted">A company licence does not mean this role sponsors.</p>
      </div>
    </div>
  );
}

export default async function JobDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<JobDetail>(`/api/jobs/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Job" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const { job: j, company, observations, sources, verifications, reviews, audit } = res.data;
  const names = sourceNames(sources);
  const path = `/jobs/${seg(j._id)}`;
  const title = j.identity.title.value ?? j.identity.normalizedTitle;
  const reqs = j.requirements.value ?? [];
  const resp = j.responsibilities.value;
  const overrides = Object.entries(j.overrides ?? {});
  const openReviews = reviews.filter((r) => r.status === 'open');

  return (
    <>
      <PageHeader
        title={title}
        subtitle={
          <>
            <CompanyLink id={company._id}>{company.name ?? company._id}</CompanyLink>
            <code className="id">{j._id}</code>
            <StatusBadge value={j.lifecycle.state} />
            {j.status === 'merged' ? (
              <Badge tone="muted">
                merged into <JobLink id={j.mergedInto} />
              </Badge>
            ) : null}
            <ConflictFields record={j} fields={j.quality.conflictFields} />
            {openReviews.length ? <Badge tone="warn">{openReviews.length} open review(s)</Badge> : null}
          </>
        }
        actions={
          <>
            <ActionForm
              action={verifyJobAction}
              submitLabel="Verify now"
              variant="primary"
              inline
              hidden={{ jobId: j._id, revalidate: path }}
            />
            <ActionForm
              action={reinterpretJobAction}
              submitLabel="Re-interpret"
              inline
              hidden={{ jobId: j._id, revalidate: path }}
            />
          </>
        }
      />

      <div className="grid-2">
        <Section title="Identity" id="identity">
          <FactGroup>
            <FactProperty
              label="Title"
              fact={j.identity.title}
              sources={names}
              operatorHref="#conflicts"
              note={<span className="muted">normalized: {j.identity.normalizedTitle}</span>}
            />
            <FactProperty
              label="Role family"
              fact={j.identity.roleFamily}
              sources={names}
              operatorHref="#conflicts"
            />
            <FactProperty
              label="Specialization"
              fact={j.identity.specialization}
              sources={names}
              operatorHref="#conflicts"
            />
            <FactProperty
              label="Department"
              fact={j.identity.department}
              sources={names}
              operatorHref="#conflicts"
            />
            <FactProperty
              label="Seniority"
              fact={j.identity.seniority}
              sources={names}
              operatorHref="#conflicts"
              render={(v) => humanize(v)}
            />
            <FactProperty
              label="Employment type"
              fact={j.employment.employmentType}
              sources={names}
              operatorHref="#conflicts"
              render={(v) => humanize(v)}
            />
          </FactGroup>
        </Section>
        <Section title="Company & application" id="company">
          <KV
            items={[
              [
                'Company',
                <CompanyLink key="c" id={company._id}>
                  {company.name ?? company._id}
                </CompanyLink>,
              ],
              ['Company domain', company.domain],
              ['Requisition id', j.requisitionId ? <code>{j.requisitionId}</code> : null],
              ['Canonical posting', <ExternalLink key="p" href={j.application.canonicalPostingUrl} />],
              ['Apply URL', <ExternalLink key="a" href={j.application.applyUrl} />],
              [
                'ATS',
                j.application.ats
                  ? `${j.application.ats.provider}${j.application.ats.boardToken ? `:${j.application.ats.boardToken}` : ''}`
                  : null,
              ],
              ['Listed locations', list(j.geography.listedLocations)],
              [
                'Normalized locations',
                j.geography.normalizedLocations.length
                  ? j.geography.normalizedLocations
                      .map((l) => `${fmtLocation(l)}${l.isRemoteLabel ? ' (remote label)' : ''}`)
                      .join(' · ')
                  : null,
              ],
              ['Sources', `${j.quality.sourceCount}`],
              ['Created', <RelTime key="cr" iso={j.createdAt} abs />],
              ['Updated', <RelTime key="up" iso={j.updatedAt} abs />],
            ]}
          />
        </Section>
      </div>

      <Section
        title={`Source copies (${j.sourceRefs.length})`}
        id="sources"
        description="Every source that lists this job. The most authoritative present copy drives identity/content."
      >
        <DataTable
          caption="Source copies"
          rows={j.sourceRefs}
          rowKey={(r) => r.key}
          rowClassName={(r) => (r.present ? undefined : 'row-muted')}
          columns={[
            { key: 'src', header: 'Source', cell: (r) => <SourceLink id={r.sourceId} names={names} /> },
            { key: 'prov', header: 'Provider', cell: (r) => r.provider },
            {
              key: 'auth',
              header: 'Authority',
              cell: (r) => <Badge tone="info">{humanize(r.authority)}</Badge>,
            },
            {
              key: 'present',
              header: 'Present',
              cell: (r) => <BoolBadge value={r.present} yes="present" no="absent" />,
            },
            { key: 'ext', header: 'External id', cell: (r) => <code className="small">{r.externalId}</code> },
            {
              key: 'req',
              header: 'Req. id',
              cell: (r) => r.requisitionId ?? <span className="muted">—</span>,
            },
            { key: 'first', header: 'First seen', cell: (r) => <RelTime iso={r.firstSeenAt} /> },
            { key: 'last', header: 'Last seen', cell: (r) => <RelTime iso={r.lastSeenAt} /> },
            {
              key: 'urls',
              header: 'Posting / apply',
              cell: (r) => (
                <span className="small">
                  <ExternalLink href={r.postingUrl}>posting</ExternalLink> ·{' '}
                  <ExternalLink href={r.applyUrl}>apply</ExternalLink>
                </span>
              ),
            },
            {
              key: 'obs',
              header: 'Last observation',
              cell: (r) => <ObservationLink id={r.lastObservationId} />,
            },
          ]}
        />
      </Section>

      <div className="grid-2">
        <Section title="Lifecycle" id="lifecycle">
          <KV
            items={[
              ['State', <StatusBadge key="s" value={j.lifecycle.state} />],
              ['First seen', <RelTime key="f" iso={j.lifecycle.firstSeenAt} abs />],
              ['Last seen', <RelTime key="l" iso={j.lifecycle.lastSeenAt} abs />],
              ['Published', <RelTime key="p" iso={j.lifecycle.publishedAt} abs />],
              ['Last changed', <RelTime key="c" iso={j.lifecycle.lastChangedAt} abs />],
              [
                'Closed',
                j.lifecycle.closedAt ? (
                  <>
                    <RelTime iso={j.lifecycle.closedAt} abs />{' '}
                    {j.lifecycle.closeReason ? `— ${j.lifecycle.closeReason}` : ''}
                  </>
                ) : null,
              ],
              ['Consecutive absences', j.lifecycle.consecutiveAbsences],
              ['Consecutive not-found', j.lifecycle.consecutiveNotFound],
            ]}
          />
          <h3 style={{ marginTop: 10 }}>History</h3>
          {j.lifecycle.history.length ? (
            <ol className="timeline">
              {[...j.lifecycle.history].reverse().map((h, i) => (
                <li key={i}>
                  <div>
                    {h.from ? <StatusBadge value={h.from} /> : <span className="muted">(new)</span>} →{' '}
                    <StatusBadge value={h.to} /> <span className="muted small">{fmtDateTime(h.at)}</span>
                  </div>
                  <div className="small">
                    {h.reason}
                    {h.sourceId ? (
                      <>
                        {' '}
                        · <SourceLink id={h.sourceId} names={names} />
                      </>
                    ) : null}
                    {h.evidence ? <span className="muted"> · {h.evidence}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">No transitions recorded.</p>
          )}
          {j.reposts?.length ? (
            <p className="small">
              Reposts:{' '}
              {j.reposts.map((r, i) => (
                <span key={i} className="label-chip">
                  {fmtDateTime(r.at)} via <code>{r.sourceKey}</code> (was {r.previousState})
                </span>
              ))}
            </p>
          ) : null}
        </Section>
        <Section title="Verification & freshness" id="verification">
          <KV
            items={[
              [
                'Last outcome',
                j.verification.lastOutcome ? (
                  <StatusBadge value={j.verification.lastOutcome} />
                ) : (
                  <span className="muted">never verified</span>
                ),
              ],
              ['Last verified', <RelTime key="v" iso={j.verification.lastVerifiedAt} abs />],
              [
                'Next verification due',
                j.verification.nextVerificationDueAt ? (
                  <span
                    className={
                      new Date(j.verification.nextVerificationDueAt).getTime() < Date.now()
                        ? 'text-warn'
                        : undefined
                    }
                  >
                    <RelTime iso={j.verification.nextVerificationDueAt} abs />
                    {new Date(j.verification.nextVerificationDueAt).getTime() < Date.now()
                      ? ' (overdue)'
                      : ''}
                  </span>
                ) : null,
              ],
            ]}
          />
          <DataTable
            caption="Verification history"
            rows={verifications}
            rowKey={(v) => v._id}
            empty="No verification attempts."
            columns={[
              { key: 'at', header: 'When', cell: (v) => <RelTime iso={v.at} /> },
              { key: 'method', header: 'Method', cell: (v) => humanize(v.method) },
              { key: 'outcome', header: 'Outcome', cell: (v) => <StatusBadge value={v.outcome} /> },
              { key: 'http', header: 'HTTP', numeric: true, cell: (v) => v.httpStatus ?? '—' },
              {
                key: 'state',
                header: 'State',
                cell: (v) => (
                  <span className="small">
                    {v.stateBefore} → {v.stateAfter}
                  </span>
                ),
              },
              {
                key: 'detail',
                header: 'Detail',
                className: 'wrap-cell',
                cell: (v) => (
                  <span className="small">
                    {v.detail}
                    {v.url ? (
                      <>
                        {' '}
                        · <ExternalLink href={v.url}>url</ExternalLink>
                      </>
                    ) : null}
                    {v.artifactId ? (
                      <>
                        {' '}
                        · <ArtifactLink id={v.artifactId}>evidence</ArtifactLink>
                      </>
                    ) : null}
                    {v.runId ? (
                      <>
                        {' '}
                        · <RunLink id={v.runId}>run</RunLink>
                      </>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </Section>
      </div>

      <Section title="Work model & remote scope" id="work-model">
        <FactGroup>
          <FactProperty
            label="Work model"
            fact={j.geography.workModel}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <strong>{humanize(v)}</strong>}
          />
          <FactProperty
            label="Remote scope"
            fact={j.geography.remoteScope}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <RemoteScopeView v={v} />}
          />
          <FactProperty
            label="Office attendance"
            fact={j.geography.officeAttendance}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <AttendanceView v={v} />}
          />
        </FactGroup>
      </Section>

      <Section title="Sponsorship, authorization & relocation" id="immigration">
        <SponsorshipPanel fact={j.immigration.sponsorship} company={company} />
        <FactGroup>
          <FactProperty
            label="Sponsorship (job)"
            fact={j.immigration.sponsorship}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <SponsorshipValue v={v} />}
            note={<span className="muted">A company licence does not mean this role sponsors.</span>}
          />
          <FactProperty
            label="Work authorization"
            fact={j.immigration.authorization}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <AuthorizationView v={v} />}
          />
          <FactProperty
            label="Relocation"
            fact={j.immigration.relocation}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <StatusBadge value={v} />}
          />
        </FactGroup>
      </Section>

      <Section title="Compensation" id="compensation">
        <FactGroup>
          <FactProperty
            label="Compensation"
            fact={j.compensation}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => <CompensationView v={v} />}
          />
        </FactGroup>
      </Section>

      <Section title={`Requirements (${reqs.length})`} id="requirements">
        <FactGroup>
          <FactProperty
            label="Requirements fact"
            fact={j.requirements}
            sources={names}
            operatorHref="#conflicts"
            render={(v) => `${v.length} extracted`}
          />
        </FactGroup>
        <DataTable<Requirement>
          caption="Requirements"
          rows={reqs}
          rowKey={(r, i) => `${i}-${r.text.slice(0, 20)}`}
          empty="No requirements extracted."
          columns={[
            { key: 'text', header: 'Requirement', className: 'wrap-cell', cell: (r) => r.text },
            {
              key: 'concept',
              header: 'Concept',
              cell: (r) => r.normalizedConcept ?? <span className="muted">—</span>,
            },
            {
              key: 'imp',
              header: 'Importance',
              cell: (r) => (
                <Badge
                  tone={r.importance === 'critical' ? 'bad' : r.importance === 'important' ? 'warn' : 'muted'}
                >
                  {r.importance}
                </Badge>
              ),
            },
            { key: 'cat', header: 'Category', cell: (r) => humanize(r.category) },
            { key: 'exp', header: 'Explicitness', cell: (r) => r.explicitness },
            { key: 'years', header: 'Years', numeric: true, cell: (r) => r.yearsMin ?? '—' },
            { key: 'section', header: 'Section', cell: (r) => r.section ?? <span className="muted">—</span> },
            {
              key: 'conf',
              header: 'Confidence',
              cell: (r) => <StatusBadge value={r.confidence} kind="confidence" />,
            },
            {
              key: 'ev',
              header: 'Evidence',
              className: 'wrap-cell',
              cell: (r) => <Spans spans={[r.evidence]} />,
            },
          ]}
        />
      </Section>

      <Section title="Responsibility signals" id="responsibilities">
        {resp ? (
          <DataTable
            caption="Responsibility signals"
            rows={Object.entries(resp)}
            rowKey={([k]) => k}
            columns={[
              {
                key: 'k',
                header: 'Signal',
                cell: ([k]) => humanize(k.replace(/([A-Z])/g, '_$1').toLowerCase()),
              },
              { key: 'p', header: 'Present', cell: ([, v]) => <BoolBadge value={v.present} /> },
              {
                key: 'e',
                header: 'Evidence',
                className: 'wrap-cell',
                cell: ([, v]) => <Spans spans={v.evidence} />,
              },
            ]}
          />
        ) : (
          <p className="empty">Unknown.</p>
        )}
      </Section>

      <div className="grid-2">
        <Section title="Interpretation" id="interpretation">
          <KV
            items={[
              ['Logic version', <code key="l">{j.interpretation.logicVersion}</code>],
              ['Policy version', <code key="p">{j.interpretation.policyVersion}</code>],
              ['Taxonomy version', <code key="t">{j.interpretation.taxonomyVersion}</code>],
              ['Computed', <RelTime key="c" iso={j.interpretation.computedAt} abs />],
              [
                'Based on observation',
                <ObservationLink key="o" id={j.interpretation.basedOnObservationId} />,
              ],
              ['Primary observation', <ObservationLink key="po" id={j.content.primaryObservationId} />],
            ]}
          />
          <h3 style={{ marginTop: 10 }}>Flags</h3>
          <DataTable
            caption="Interpretation flags"
            rows={j.interpretation.flags}
            rowKey={(f, i) => `${f.code}-${i}`}
            empty="No flags."
            columns={[
              {
                key: 'sev',
                header: 'Severity',
                cell: (f) => <StatusBadge value={f.severity} kind="severity" />,
              },
              { key: 'code', header: 'Code', cell: (f) => <code>{f.code}</code> },
              { key: 'msg', header: 'Message', className: 'wrap-cell', cell: (f) => f.message },
            ]}
          />
        </Section>
        <Section title="Conflicts, overrides & duplicates" id="conflicts">
          <KV
            items={[
              [
                'Conflict fields',
                j.quality.conflictFields.length ? (
                  <ConflictFields record={j} fields={j.quality.conflictFields} variant="text" />
                ) : (
                  'none'
                ),
              ],
              [
                'Duplicate of (merged in)',
                j.duplicateOf?.length
                  ? j.duplicateOf.map((d) => (
                      <Fragment key={d}>
                        <JobLink id={d} />{' '}
                      </Fragment>
                    ))
                  : null,
              ],
              [
                'Declared distinct from',
                j.distinctFrom?.length
                  ? j.distinctFrom.map((d) => (
                      <Fragment key={d}>
                        <JobLink id={d} />{' '}
                      </Fragment>
                    ))
                  : null,
              ],
            ]}
          />
          <p className="small muted">Per-field conflicting evidence is shown under each fact above.</p>
          <h3 style={{ marginTop: 10 }}>Operator overrides</h3>
          {overrides.length ? (
            <DataTable
              caption="Overrides"
              rows={overrides}
              rowKey={([k]) => k}
              columns={[
                { key: 'f', header: 'Field', cell: ([k]) => <code>{k}</code> },
                { key: 'v', header: 'Value', cell: ([, o]) => <JsonView value={o.value} label="value" /> },
                { key: 'r', header: 'Reason', cell: ([, o]) => o.reason },
                { key: 'a', header: 'By', cell: ([, o]) => o.actorId },
                { key: 'at', header: 'When', cell: ([, o]) => <RelTime iso={o.at} /> },
              ]}
            />
          ) : (
            <p className="empty">No overrides.</p>
          )}
        </Section>
      </div>

      <Section title={`AI proposals (${j.aiProposals?.length ?? 0})`} id="ai">
        <DataTable
          caption="AI proposals"
          rows={j.aiProposals ?? []}
          rowKey={(p, i) => `${p.task}-${i}`}
          empty="No AI proposals."
          columns={[
            { key: 'task', header: 'Task', cell: (p) => <code>{p.task}</code> },
            {
              key: 'applied',
              header: 'Applied',
              cell: (p) => <BoolBadge value={p.applied} yes="applied" no="not applied" />,
            },
            { key: 'at', header: 'Created', cell: (p) => <RelTime iso={p.createdAt} /> },
            { key: 'meta', header: 'Provenance', cell: (p) => <JsonView value={p.meta} label="meta" /> },
            { key: 'data', header: 'Proposal', cell: (p) => <JsonView value={p.data} label="data" /> },
          ]}
        />
      </Section>

      <Section title="Description" id="description">
        <p className="small">
          {j.content.descriptionArtifactId ? (
            <>
              Raw description artifact: <ArtifactLink id={j.content.descriptionArtifactId} /> ·{' '}
            </>
          ) : null}
          hash <code className="small">{j.content.descriptionHash.slice(0, 16)}</code>
        </p>
        <TextBlock text={j.content.descriptionText} label="Description text" />
      </Section>

      <Section title={`Observations (${observations.length})`} id="observations">
        <ObservationsTable observations={observations} sources={names} />
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
