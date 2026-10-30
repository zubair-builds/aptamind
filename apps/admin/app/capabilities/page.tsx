import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, BoolBadge } from '@/components/Badge';
import { JsonView } from '@/components/Json';
import { PageHeader, Section } from '@/components/Section';
import { apiGet } from '@/lib/api';
import { fmtDuration } from '@/lib/format';
import type { Capability } from '@/lib/types';

export const metadata = { title: 'Capabilities' };

export default async function CapabilitiesPage() {
  const res = await apiGet<{ items: Capability[] }>('/api/capabilities');
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Capabilities" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const byCategory = new Map<string, Capability[]>();
  for (const c of res.data.items) byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  const categories = [...byCategory.keys()].sort();

  return (
    <>
      <PageHeader
        title="Capabilities"
        subtitle={`${res.data.items.length} registered capability versions (type@version) available to workflow nodes.`}
      />
      {categories.map((cat) => (
        <Section key={cat} title={`${cat} (${byCategory.get(cat)?.length ?? 0})`} id={`cat-${cat}`}>
          <div className="table-wrap" role="region" aria-label={`${cat} capabilities`} tabIndex={0}>
            <table className="table">
              <caption className="sr-only">{cat} capabilities</caption>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Description</th>
                  <th scope="col">Execution</th>
                  <th scope="col">Schemas</th>
                </tr>
              </thead>
              <tbody>
                {(byCategory.get(cat) ?? []).map((c) => (
                  <tr key={c.key} id={c.key}>
                    <td>
                      <code>{c.key}</code>
                      <div>
                        <strong>{c.title}</strong>
                      </div>
                    </td>
                    <td className="wrap-cell small">{c.description}</td>
                    <td className="small">
                      <div>
                        idempotency{' '}
                        <Badge tone={c.execution.idempotency === 'none' ? 'warn' : 'muted'}>
                          {c.execution.idempotency}
                        </Badge>
                      </div>
                      <div>
                        side effects <BoolBadge value={c.execution.sideEffects} />
                      </div>
                      <div>
                        retryable <BoolBadge value={c.execution.retryable} />
                      </div>
                      <div>
                        queue <code>{c.execution.queue ?? 'default'}</code> · mode{' '}
                        <code>{c.execution.mode ?? 'standard'}</code>
                      </div>
                      {c.execution.defaultTimeoutMs ? (
                        <div>timeout {fmtDuration(c.execution.defaultTimeoutMs)}</div>
                      ) : null}
                    </td>
                    <td>
                      <JsonView value={c.configSchema} label="config schema" />
                      <JsonView value={c.inputSchema} label="input schema" />
                      <JsonView value={c.outputSchema} label="output schema" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}
    </>
  );
}
