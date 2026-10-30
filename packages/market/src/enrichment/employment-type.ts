import { findEmploymentTypes } from '@aptamind/taxonomy';
import type { EmploymentType } from '@aptamind/taxonomy';
import { sentences, spanOf, spanOfSegment, syntheticSpan } from './text';
import type { Interpreted, InterpretationFlag } from './text';

/**
 * Employment type from (in order of authority) the provider label, the title, then explicit
 * description statements. Description mentions are only trusted in sentences that talk about the
 * role/position/contract itself, so "we work with contractors" does not make a job a contract.
 */

const ROLE_CONTEXT =
  /\b(?:this\s+is\s+an?|position|role|job|employment\s+type|contract\s+(?:length|duration|type)|engagement|basis|opportunity|hours|schedule)\b/i;

export interface EmploymentTypeResult {
  employmentType: Interpreted<EmploymentType>;
  flags: InterpretationFlag[];
}

export function interpretEmploymentType(
  title: string,
  description: string,
  providerText?: string | null,
): EmploymentTypeResult {
  const flags: InterpretationFlag[] = [];
  const provider = providerText?.trim() ? findEmploymentTypes(providerText) : [];
  const fromTitle = findEmploymentTypes(title);

  const described: Array<{ type: EmploymentType; seg: ReturnType<typeof sentences>[number] }> = [];
  for (const seg of sentences(description)) {
    const lineIsLabel = /^(?:employment\s+type|job\s+type|type|contract)\s*:/i.test(seg.text);
    if (!lineIsLabel && !ROLE_CONTEXT.test(seg.text)) continue;
    for (const m of findEmploymentTypes(seg.text)) described.push({ type: m.type, seg });
  }

  const providerType = provider[0];
  if (providerType && providerText) {
    const evidence = [syntheticSpan('provider', `employmentType: ${providerText.trim()}`)];
    const conflicting = described.find(
      (d) => d.type !== providerType.type && !compatible(providerType.type, d.type),
    );
    if (conflicting) {
      flags.push({
        code: 'employment_type_conflict',
        message: `Provider says ${providerType.type} but the description says ${conflicting.type}.`,
        severity: 'warning',
      });
      evidence.push(spanOfSegment('description', description, conflicting.seg));
    }
    return {
      employmentType: {
        value: providerType.type,
        confidence: conflicting ? 'medium' : 'high',
        evidence,
        basis: 'provider.employmentType',
      },
      flags,
    };
  }

  const titleType = fromTitle[0];
  if (titleType) {
    return {
      employmentType: {
        value: titleType.type,
        confidence: 'high',
        evidence: [spanOf('title', title, titleType.index, titleType.index + titleType.matchedText.length)],
        basis: 'title.explicit',
      },
      flags,
    };
  }

  const first = described[0];
  if (first) {
    const distinct = new Set(described.map((d) => d.type));
    const others = [...distinct].filter((t) => t !== first.type && !compatible(first.type, t));
    if (others.length) {
      flags.push({
        code: 'employment_type_ambiguous',
        message: `Description mentions several employment types: ${[...distinct].join(', ')}.`,
        severity: 'info',
      });
    }
    return {
      employmentType: {
        value: first.type,
        confidence: others.length ? 'low' : 'medium',
        evidence: described.slice(0, 3).map((d) => spanOfSegment('description', description, d.seg)),
        basis: 'description.explicit',
      },
      flags,
    };
  }
  return { employmentType: { value: 'unclear', confidence: 'unknown', evidence: [], basis: 'none' }, flags };
}

/** Pairs that commonly co-occur without contradiction ("full-time contract", "full-time internship"). */
function compatible(a: EmploymentType, b: EmploymentType): boolean {
  const pair = new Set([a, b]);
  return (
    (pair.has('full_time') &&
      (pair.has('contract') ||
        pair.has('internship') ||
        pair.has('temporary') ||
        pair.has('apprenticeship'))) ||
    (pair.has('contract') && (pair.has('temporary') || pair.has('freelance')))
  );
}
