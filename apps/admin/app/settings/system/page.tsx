import { PageHeader, Section } from '@/components/Section';
import { PropertyList } from '@/components/ui/PropertyList';
import { StatusPill } from '@/components/ui/StatusPill';
import { getApiHealth, HEALTH_LABEL } from '@/lib/health';

export const metadata = { title: 'System status' };

const TONE = { ready: 'success', not_ready: 'warning', unavailable: 'danger' } as const;

export default async function SystemPage() {
  const health = await getApiHealth();
  return (
    <>
      <PageHeader title="System status" subtitle="Connection from this admin to the internal API." />
      <Section title="Internal API" id="api">
        <PropertyList
          items={[
            {
              label: 'Status',
              value: <StatusPill tone={TONE[health.state]}>{HEALTH_LABEL[health.state]}</StatusPill>,
            },
            { label: 'Base URL', value: <code>{health.url}</code> },
            health.message ? { label: 'Last error', value: health.message } : null,
          ]}
        />
        {health.checks ? (
          <div className="table-wrap" role="region" aria-label="Readiness checks" tabIndex={0}>
            <table className="table">
              <caption className="sr-only">Readiness checks</caption>
              <thead>
                <tr>
                  <th scope="col">Dependency</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(health.checks).map(([name, ok]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>
                      <StatusPill tone={ok ? 'success' : 'danger'}>{ok ? 'ready' : 'not ready'}</StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>
      <Section title="Access" id="access">
        <p>
          Internal operations tool with <strong>no authentication</strong> in v0.1 (ADR-0008). Every visitor
          acts as the unauthenticated internal operator. Keep the admin and the API on a private interface and
          never expose them publicly.
        </p>
      </Section>
    </>
  );
}
