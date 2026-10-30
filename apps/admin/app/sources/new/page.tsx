import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { PageHeader, Section } from '@/components/Section';
import { createSourceAction } from '@/lib/actions';

export const metadata = { title: 'New source' };

const TEMPLATE = {
  key: 'greenhouse:example',
  name: 'Example Co — Greenhouse',
  category: 'job_source',
  provider: 'greenhouse',
  endpoint: { boardToken: 'example' },
  acquisition: { workflowKey: 'market.ats.refresh', config: {} },
  schedule: { intervalMinutes: 360, timezone: 'UTC' },
  freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
  authority: { tier: 'official_ats', authoritativeFor: ['job postings'], listingIsComplete: true },
  governance: { accessMethod: 'public_api', termsNotes: '' },
  enabled: true,
  labels: {},
};

export default function NewSourcePage() {
  return (
    <>
      <PageHeader title="New source" />
      <Section
        title="Source definition (JSON)"
        description={
          <>
            POSTed to <code>/api/sources</code>. Registration is idempotent on <code>key</code>. Adjust the
            workflow key to one listed on the <Link href="/workflows">Workflows</Link> page; add{' '}
            <code>companyId</code> for a company's job board; never put secrets in <code>config</code> (use{' '}
            <code>credentialRefs</code>).
          </>
        }
      >
        <ActionForm action={createSourceAction} submitLabel="Create source" variant="primary">
          <label className="field">
            <span>Definition</span>
            <textarea
              name="definition"
              rows={28}
              defaultValue={JSON.stringify(TEMPLATE, null, 2)}
              spellCheck={false}
              required
            />
          </label>
        </ActionForm>
      </Section>
    </>
  );
}
