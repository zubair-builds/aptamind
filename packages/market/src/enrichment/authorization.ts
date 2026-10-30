import { findCountries } from '@aptamind/taxonomy';
import type { EvidenceSpan, JobInterpretation } from '../contracts/employment';
import { cutAtClause, geoOf } from './remote-scope';
import { sentences, spanOf, unique } from './text';
import type { Interpreted } from './text';

/**
 * Existing work-authorisation requirements ("must have the right to work in the UK", "must be
 * authorized to work in the US without sponsorship", "SC clearance required"). This is separate
 * from sponsorship: a right-to-work requirement alone does not mean the company refuses to sponsor.
 */

export type Authorization = JobInterpretation['authorization']['value'];

const AUTH_PHRASE =
  /\b(?:right\s+to\s+work|work(?:ing)?\s+(?:authori[sz]ation|permit|rights?|visa)|authori[sz]ed\s+to\s+work|eligib(?:le|ility)\s+to\s+work|legally\s+(?:able|entitled|permitted|allowed)\s+to\s+work|permission\s+to\s+work)\b/i;
const REQUIREMENT_CUE =
  /\b(?:must|required?|requires|requirement|need|needs|essential|necessary|mandatory|only\s+consider|should\s+have|you\s+(?:will\s+)?(?:have|hold)|eligible|without\s+(?:the\s+)?need|able\s+to\s+provide|proof\s+of)\b/i;

const QUALIFIERS: ReadonlyArray<{ qualifier: string; pattern: RegExp }> = [
  {
    qualifier: 'security_clearance',
    pattern:
      /\b(?:security\s+clearance|SC\s+clear(?:ance|ed)|DV\s+clear(?:ance|ed)|NV[12]\s+clearance|TS\/SCI|top\s+secret|secret\s+clearance|active\s+clearance|(?:able|eligible)\s+to\s+obtain\s+(?:a\s+)?(?:security\s+)?clearance|BPSS)\b/,
  },
  {
    qualifier: 'citizenship',
    pattern:
      /\b(?:must\s+be\s+an?\s+[\w.]+\s+citizen|citizenship\s+(?:is\s+)?required|(?:U\.?S\.?|UK|British|EU|Canadian|Australian)\s+citizens?(?:hip)?\s+(?:only|required|is\s+required)|citizens\s+only)\b/i,
  },
  {
    qualifier: 'permanent_residency',
    pattern:
      /\b(?:green\s+card|permanent\s+residen(?:ts?|cy)|indefinite\s+leave\s+to\s+remain|settled\s+status|pre-settled\s+status)\b/i,
  },
];

/** "sponsorship" as a skill or function ("sponsorship experience"), not a visa need (A-L2). */
const NOT_A_VISA_NEED = String.raw`(?!\s+(?:experience|approvals?|authority|knowledge|skills?|background|expertise|process(?:es)?|work|team|programmes?|programs?|deals?|packages?|budgets?)\b)`;

/**
 * Where the requirement's geography ends: a clause about the job's location or remote scope
 * ("… and be based in Europe", "…; this is a remote role within the EMEA region") is not part
 * of the authorization (PR #21 review A-M2). `cutAtClause` first, then these breaks.
 */
const AUTH_CLAUSE_END =
  /[;:(]|,\s+(?:this|the\s+(?:role|position|job)|which|while|and\s+(?:be|to|you|we)|you|we|our)\b|\s+and\s+(?:be|to|you|must|should|will|are|is|live|reside|work|have|hold|relocate)\b|\s+(?:while|but|as|where|because|this|who)\b|\s+(?:based|located|living|residing)\s+(?:in|within)\b/i;

function authClause(fragment: string): string {
  const cut = cutAtClause(fragment);
  const m = cut.slice(1).match(AUTH_CLAUSE_END);
  return m && m.index !== undefined ? cut.slice(0, m.index + 1) : cut;
}

/**
 * "Without needing sponsorship" / "must not require sponsorship now or in the future": the role
 * requires existing authorization (M11.1: the latter used to leave `required` null).
 */
const NO_SPONSORSHIP_NEEDED: readonly RegExp[] = [
  new RegExp(
    String.raw`\bwithout\s+(?:the\s+)?(?:need|requirement|requiring)\s+(?:for|of)?\s*(?:current\s+or\s+future\s+|visa\s+|employer\s+)?(?:visa\s+)?sponsorship\b${NOT_A_VISA_NEED}`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:not|never)\s+(?:currently\s+|now\s+or\s+in\s+the\s+future\s+)?(?:require|need)\s+(?:visa\s+|employer\s+|company\s+|immigration\s+)?sponsorship\b${NOT_A_VISA_NEED}`,
    'i',
  ),
  new RegExp(
    String.raw`\bno\s+(?:current\s+or\s+future\s+)?(?:need|requirement)\s+for\s+(?:visa\s+|employer\s+)?sponsorship\b${NOT_A_VISA_NEED}`,
    'i',
  ),
];

export function interpretAuthorization(description: string): Interpreted<Authorization> {
  const countries: string[] = [];
  const regions: string[] = [];
  const qualifiers: string[] = [];
  const evidence: EvidenceSpan[] = [];
  let strong = false;

  for (const s of sentences(description)) {
    const auth = s.text.match(AUTH_PHRASE);
    const withoutSponsorship = NO_SPONSORSHIP_NEEDED.some((re) => re.test(s.text));
    const quals = QUALIFIERS.filter((q) => q.pattern.test(s.text)).map((q) => q.qualifier);
    const isRequirement = (auth && REQUIREMENT_CUE.test(s.text)) || withoutSponsorship || quals.length > 0;
    if (!isRequirement) continue;
    const from = auth?.index ?? 0;
    const geo = geoOf(authClause(s.text.slice(from)));
    const named = geo.countries.length ? geo.countries : findCountries(s.text).map((c) => c.code);
    countries.push(...named);
    // Region-level requirements ("eligible to work in an EU country"): kept as regions, never
    // expanded into invented countries.
    regions.push(...geo.regions);
    qualifiers.push(...quals);
    evidence.push(spanOf('description', description, s.start, s.end));
    strong ||= /\b(?:must|required?|requires|essential|mandatory|only)\b/i.test(s.text);
  }

  if (!evidence.length) {
    return {
      value: { required: null, countries: [], regions: [], qualifiers: [] },
      confidence: 'unknown',
      evidence: [],
      basis: 'none',
    };
  }
  return {
    value: {
      required: true,
      countries: unique(countries),
      regions: unique(regions),
      qualifiers: unique(qualifiers),
    },
    confidence: strong ? 'high' : 'medium',
    evidence: evidence.slice(0, 5),
    basis: 'description.explicit',
  };
}
