import { Badge } from '@/components/Badge';

/*
 * The API's `quality.conflictFields` lists fields where sources disagree or alternates were kept
 * (Market reconcilers). The header must say the same as the fact rows, so each listed field is
 * labelled by that fact's own `status` from the same response: `conflicting` → "Sources
 * disagree" (warning); a fact with kept alternates → "Other values kept" (neutral). A listed
 * field whose fact cannot be found in the record stays under "Sources disagree" — the API said so.
 */

interface FactLike {
  status?: unknown;
  conflicts?: unknown[];
}

function factAt(record: unknown, path: string): FactLike | undefined {
  let cur: unknown = record;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === 'object' && 'status' in cur ? (cur as FactLike) : undefined;
}

export function splitConflictFields(record: unknown, fields: string[]) {
  const disagree: string[] = [];
  const otherValues: string[] = [];
  for (const f of fields) {
    const fact = factAt(record, f);
    if (fact && fact.status !== 'conflicting') otherValues.push(f);
    else disagree.push(f);
  }
  return { disagree, otherValues };
}

/** "geography.remoteScope" → "remote scope". */
export const fieldLabel = (path: string) =>
  (path.split('.').at(-1) ?? path)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();

const list = (fields: string[]) => fields.map(fieldLabel).join(', ');

const fieldsN = (n: number) => `${n} field${n === 1 ? '' : 's'}`;

/**
 * Header / quality badges for a record's `quality.conflictFields`. The list is what the API
 * flagged, not every fact that kept alternates (reconcilers flag some fields only), so the
 * neutral group is worded as flagged fields and the rows carry the full per-fact counts.
 */
export function ConflictFields({
  record,
  fields,
  variant = 'full',
}: {
  record: unknown;
  fields: string[];
  /** `count`: "2 disagree · 1 other value" for table cells; `text`: wrapping text for property rows. */
  variant?: 'full' | 'count' | 'text';
}) {
  if (!fields.length) return null;
  const { disagree, otherValues } = splitConflictFields(record, fields);
  const otherTitle =
    'Fields the API flagged as keeping other values. Other facts can keep alternates too: see "+N other values" on each row.';
  if (variant === 'count')
    return (
      <>
        {disagree.length ? (
          <span className="text-warn"> · {fieldsN(disagree.length)} where sources disagree</span>
        ) : null}
        {otherValues.length ? (
          <span className="muted" title={otherTitle}>
            {' '}
            · {fieldsN(otherValues.length)} with other values
          </span>
        ) : null}
      </>
    );
  if (variant === 'text')
    return (
      <>
        {disagree.length ? <span className="text-warn">Sources disagree: {list(disagree)}</span> : null}
        {disagree.length && otherValues.length ? ' · ' : null}
        {otherValues.length ? (
          <span className="muted" title={otherTitle}>
            Flagged with other values: {list(otherValues)}
          </span>
        ) : null}
      </>
    );
  return (
    <>
      {disagree.length ? (
        <Badge tone="warn" title={disagree.join(', ')}>
          Sources disagree: {list(disagree)}
        </Badge>
      ) : null}
      {disagree.length && otherValues.length ? ' ' : null}
      {otherValues.length ? (
        <Badge tone="muted" title={otherTitle}>
          Flagged with other values: {list(otherValues)}
        </Badge>
      ) : null}
    </>
  );
}
