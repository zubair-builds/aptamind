import { StatusPill } from '@/components/ui/StatusPill';
import { humanize } from '@/lib/format';
import type { Sponsorship } from '@/lib/types';

const ROLE: Record<Sponsorship['roleStatement'], { text: string; tone: 'success' | 'neutral' }> = {
  yes: { text: 'Role offers sponsorship', tone: 'success' },
  no: { text: 'Role: no sponsorship', tone: 'neutral' },
  none: { text: 'Role says nothing', tone: 'neutral' },
};

const EMPLOYER: Record<Sponsorship['companyCapability'], string> = {
  licensed: 'Employer holds a licence',
  historical: 'Employer sponsored before',
  none: 'Employer: no licence on record',
  unknown: 'Employer: unknown',
};

/**
 * A job's sponsorship value as the API returns it, on its two independent axes: what the role
 * says (`roleStatement`) and what the employer can do (`companyCapability`). An employer licence
 * is never presented as the role sponsoring (contract `market-provenance.md`); the combined
 * `status` is in the tooltip.
 */
export function SponsorshipValue({ v }: { v: Sponsorship }) {
  const role = ROLE[v.roleStatement] ?? { text: `Role: ${humanize(v.roleStatement)}`, tone: 'neutral' };
  const employer = EMPLOYER[v.companyCapability] ?? `Employer: ${humanize(v.companyCapability)}`;
  const countries = v.companyCapability === 'licensed' || v.companyCapability === 'historical';
  return (
    <span title={`API status: ${humanize(v.status)}`} className="sponsorship-value">
      {/* "unclear" is the API's own status: said in words, not only in the tooltip. */}
      {v.status === 'unclear' ? (
        <>
          <StatusPill tone="neutral">Unclear</StatusPill>{' '}
        </>
      ) : null}
      <StatusPill tone={role.tone}>{role.text}</StatusPill>{' '}
      <span className="muted small">
        · {employer}
        {countries && v.capabilityCountries.length ? ` (${v.capabilityCountries.join(', ')})` : ''}
      </span>
    </span>
  );
}
