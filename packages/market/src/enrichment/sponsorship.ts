import { countriesOfRegion } from '@aptamind/taxonomy';
import type { EvidenceSpan, JobInterpretation, Sponsorship } from '../contracts/employment';
import { lines, sentencesOf, spanOf, stripBullet, syntheticSpan, unique } from './text';
import type { Interpreted, InterpretationFlag, Segment } from './text';

/**
 * Visa sponsorship. The role's own statement is kept separate from company capability
 * (context doc §13). Evidence hierarchy: role explicit statement > application constraint >
 * company policy > company capability > hiring history > inference.
 *
 *  - the posting never decides the status: a structured line is only a stated value
 *    (`sponsorship_stated`); `explicit_yes` / `explicit_no` come only from an operator assertion
 *    (applied by the job reconciler) or a typed provider field (none today) — DECISION_LOG 012d041;
 *  - a stated value does not suppress company-level evidence: the status follows the company axis
 *    below with its flags, the stated value a flag next to it (8d96663 (5));
 *  - a current sponsor licence covering the job's countries is only `company_capable` (never
 *    `explicit_yes`); a right-to-work requirement for those countries lowers it to low
 *    confidence with an info flag (M11.1);
 *  - a licence when the job's countries are unknown stays `unclear`, the capability recorded
 *    (M11.1, supervisor-approved: unknown stays unknown);
 *  - a lapsed licence is past capability (`previously_licensed`), not hiring history: `unclear`;
 *  - hiring-history evidence (`historicalSponsorshipCountries`) is `historical_evidence`;
 *  - everything else stays `unclear`.
 */

/**
 * Sponsorship in the posting, v0.1 final (DECISION_LOG 012d041; supersedes the verdict part of
 * 4c34779 / 9186ad2). Posting text — description, title and location — NEVER yields a
 * sponsorship verdict: seven out-of-sample rounds showed that no keyword, position or
 * stand-alone rule can tell a real role statement from restrictions in other languages, split
 * terms, back-references or residency wording. So:
 *
 *  - one text line `key separator yes|no` whose KEY names visa / work-permit / immigration
 *    sponsorship ("Visa sponsorship: yes", "Visa Sponsorship Available: No", "Work permit
 *    sponsorship = no") is a STATEMENT: flag `sponsorship_stated` with the stated value and the
 *    line as evidence; it never decides the status. Stated values of both polarities are a
 *    conflict (`sponsorship_conflict`, high → employment_conflict review; the job reconciler also
 *    compares the copies' values). A key line without a separator, another value, a footnote
 *    marker and any table layout are mentions (8d96663 (1), 3dfe3c5 (1));
 *  - every other sentence about sponsorship, visas, work permits or the right to work — in the
 *    description, the title or the location — is a `mention` (flag `sponsorship_mentioned`); a
 *    statement together with any mention is `sponsorship_mixed_statement`;
 *  - `explicit_yes` / `explicit_no` come only from an operator assertion (the review override
 *    path) or a typed provider field (none exists today).
 *
 * Text is normalised first (NFKC, zero-width characters removed, curly quotes → straight). The
 * topic detector decides relevance, never polarity.
 */

/**
 * Related content: sponsorship, visas, work permits, immigration, the right to work / work
 * authorisation, nationality or residency conditions, named visa types, and the common German,
 * French, Dutch and Spanish terms for them. Relevance only (it feeds the mention flags).
 */
const RELATED =
  /\b(?:sponsor\w*|visas?|work[\s-]?permits?|immigration|right[\s-]to[\s-]work|work[\s-]authori[sz]\w*|(?:authori[sz]ed|eligible|entitled|permitted|allowed)\s+to\s+work|work[\s-]?pass(?:es)?|employment[\s-]pass(?:es)?|residence[\s-]permits?|green[\s-]card|blue[\s-]card|h-?1b|tier[\s-]?2|skilled[\s-]worker|nationals?|nationality|citizens?(?:hip)?|residency|permanent[\s-]residents?|passports?|visum|visado|arbeitserlaubnis|aufenthalts(?:titel|erlaubnis)|autorisation\s+de\s+travail|titre\s+de\s+s[ée]jour|permis\s+de\s+travail|kennismigrant\w*|werkvergunning|verblijfsvergunning|patrocinio|permiso\s+de\s+trabajo)\b/i;
/**
 * Compounds that carry the topic inside a longer word ("Visumsponsoring", "Visaunterstützung",
 * "Arbeitsvisum", "unsponsored", "Arbeitsgenehmigung"): relevance only, never a stated value
 * (a stated value needs key + separator + value, `STRUCTURED`).
 */
const RELATED_COMPOUND =
  /sponsor|visum|\bvisa\p{L}|\p{L}visa\b|arbeitsgenehmigung|aufenthalts(?:titel|erlaubnis|genehmigung)|arbeitserlaubnis|werkvergunning|verblijfsvergunning|kennismigrant/iu;
/** Related content (relevance only). */
const isRelated = (norm: string): boolean => RELATED.test(norm) || RELATED_COMPOUND.test(norm);
/** A restriction that refers back to the role without naming the topic: related content too. */
const RESTRICTION =
  /\b(?:not|only)\b[^.;]{0,40}\b(?:this|the)\s+(?:role|position|vacancy|job|post|opening)\b|\bonly\s+(?:for|to|in)\b|\b(?:roles?|positions?|hires|candidates|staff|contracts?)\s+only\b|^[*†‡](?=\S)/i;

/** EU Blue Card: the EU minus the member states that do not take part (IE, DK). */
const BLUE_CARD_COUNTRIES = (): readonly string[] =>
  countriesOfRegion('EU').filter((c) => c !== 'IE' && c !== 'DK');

/** Structured keys: the key must name what is sponsored. Countries a country-specific type applies to. */
const VISA_KEYS: ReadonlyArray<{ re: string; countries: (() => readonly string[]) | null }> = [
  { re: String.raw`visa|work[\s-]permit|immigration|work[\s-]visa`, countries: null },
  { re: String.raw`skilled[\s-]worker(?:\s+visa)?|tier[\s-]?2`, countries: () => ['GB'] },
  { re: String.raw`h-?1b`, countries: () => ['US'] },
  { re: String.raw`(?:eu\s+)?blue[\s-]card`, countries: BLUE_CARD_COUNTRIES },
  { re: String.raw`employment[\s-]pass`, countries: () => ['SG'] },
];
const VALUE = String.raw`(yes|no)`;
const KEY = String.raw`(${VISA_KEYS.map((k) => `(?:${k.re})`).join('|')})\s+sponsorship`;
/**
 * A stated value is ONE text line `key separator yes|no`, at most a trailing period, nothing
 * else (DECISION_LOG 8d96663, narrowed by 3dfe3c5): "Visa sponsorship: yes" / "- Visa
 * sponsorship – No" / "Visa Sponsorship Available: No" / "Work permit sponsorship = no". A key
 * line without a separator, a value other than yes / no ("available", "Yes (London)"), a footnote
 * marker after the value (`*`, `**`, `†`, `‡`, `^`, superscripts) and table layouts are mentions.
 */
const SEPARATOR = String.raw`(?:\s*:\s*|\s+[-–—]\s*|\s*[–—]\s*|\s*=\s*)`;
const STRUCTURED = new RegExp(
  String.raw`^${KEY}(?:\s+(?:available|offered|provided))?${SEPARATOR}${VALUE}\.?$`,
  'i',
);
/** Paired bold around the whole key ("**Visa sponsorship:** Yes") — stripped (a bold whole line is not). */
const BOLD_KEY = /^(\*\*|__)([^*_]+?)\1(?=\s*[:=–—-]|\s)/;
/** Paired bold around the whole value ("Visa sponsorship: **No**") — stripped. */
const BOLD_VALUE = /([:=–—-]\s*)(\*\*|__)([^*_]+?)\2(\.?)$/;

/**
 * NFKC, zero-width characters (U+200B–U+200D, U+2060, U+FEFF) and soft hyphens removed, curly
 * quotes / primes to straight ones.
 */
export function normalizeStatementText(text: string): string {
  return (
    text
      // The numero sign is not the word "No" (NFKC would make it one; 7f01fe5 L3).
      .replace(/\u2116/g, '#')
      .normalize('NFKC')
      .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
  );
}

export interface SponsorshipStatement {
  /** `yes` / `no`: the value a structured line STATES (never a verdict); `mention`: other related content. */
  stance: 'yes' | 'no' | 'mention';
  sentence: Segment;
  /** For a stated value: the key as written ("H-1B sponsorship") and its country scope (bc013e8). */
  key?: string;
  /** Countries a country-specific key applies to (H-1B → US, …); null for a generic key. */
  scope?: readonly string[] | null;
}

/** The value a structured line states (`null`: not a stated-value line). */
function statedValue(
  line: string,
  jobCountries: readonly string[],
): { value: 'yes' | 'no'; key: string; scope: readonly string[] | null } | null {
  // Only PAIRED bold around the whole key or the whole value is formatting; any other marker
  // (an unpaired `**` footnote marker included) stays and makes the line a mention (3dfe3c5).
  const m = line.trim().replace(BOLD_KEY, '$2').replace(BOLD_VALUE, '$1$3$4').match(STRUCTURED);
  if (!m) return null;
  const keyText = m[1]!.trim();
  const key = VISA_KEYS.find((k) => new RegExp(`^(?:${k.re})$`, 'i').test(keyText));
  const countries = key?.countries?.();
  if (countries && !jobCountries.some((c) => countries.includes(c))) return null;
  return {
    value: /^no$/i.test(m[2]!) ? 'no' : 'yes',
    key: `${keyText} sponsorship`,
    // The key keeps its country scope (bc013e8 M4): H-1B → US, Skilled Worker / Tier 2 → GB,
    // Blue Card → participating EU; a generic key has none.
    scope: countries ? [...countries] : null,
  };
}

/** Whether two key scopes overlap; null (a generic key) overlaps every scope. */
export function scopesOverlap(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b) return true;
  return a.some((c) => b.includes(c));
}

/** Related content of a text: stated-value lines (`allowStated`) and mentions. */
export function findSponsorshipStatements(
  text: string,
  opts: {
    jobCountries?: readonly string[];
    allowStated?: boolean;
    layoutLineStarts?: readonly number[];
  } = {},
): SponsorshipStatement[] {
  const out: SponsorshipStatement[] = [];
  const layout = new Set(opts.layoutLineStarts ?? []);
  for (const line of lines(text)) {
    const item = stripBullet(line);
    const norm = normalizeStatementText(item.text);
    // A line holding text from outside the statement context (tables, struck, hidden, …) never
    // yields a stated value (3dfe3c5 (1), 5a13fed); matched by its position, not its text.
    const stated =
      opts.allowStated === false || layout.has(line.start)
        ? null
        : statedValue(norm, opts.jobCountries ?? []);
    if (stated) out.push({ stance: stated.value, sentence: item, key: stated.key, scope: stated.scope });
    // Restriction cues (a leading footnote marker) are tested before any stripping.
    else if (isRelated(norm) || RESTRICTION.test(norm)) {
      // Evidence at sentence granularity where a sentence names the topic; else the whole line.
      const related = sentencesOf(item).filter((x) => isRelated(normalizeStatementText(x.text)));
      for (const sentence of related.length ? related : [item]) out.push({ stance: 'mention', sentence });
    }
  }
  return out;
}

export interface SponsorshipInput {
  description: string;
  company: {
    sponsorLicenceCountries: readonly string[];
    historicalSponsorshipCountries: readonly string[];
    previousLicenceCountries?: readonly string[];
  } | null;
  /** Countries the job is located in / may be performed from (to check capability relevance). */
  jobCountries: readonly string[];
  /** Start offsets of description lines outside the statement context: mentions only. */
  layoutLineStarts?: readonly number[];
  /** Which rendering `description` is (labels the description evidence spans). */
  rendering?: 'html_layout' | 'description_text';
  /** The job title and location texts: scanned for mentions (never stated values). */
  title?: string;
  locationTexts?: readonly string[];
  /**
   * The role's existing-work-authorization requirement (an application constraint), if any:
   * "must have the right to work in the UK" is in tension with company capability for GB.
   */
  rightToWork?: {
    required: boolean | null;
    countries: readonly string[];
    /** Taxonomy region codes of the requirement (named as given, never expanded in messages). */
    regions?: readonly string[];
  };
}

export interface SponsorshipResult {
  sponsorship: Interpreted<Sponsorship>;
  flags: InterpretationFlag[];
}

export function interpretSponsorship(input: SponsorshipInput): SponsorshipResult {
  const { description, company } = input;
  const flags: InterpretationFlag[] = [];
  const licensed = unique(company?.sponsorLicenceCountries ?? []);
  const historical = unique(company?.historicalSponsorshipCountries ?? []);
  const lapsed = unique(company?.previousLicenceCountries ?? []).filter((c) => !licensed.includes(c));
  // The company axis is chosen per the job's countries (M11.5): the strongest tier that covers
  // them — a current licence, then hiring history, then a lapsed licence (past capability, no
  // signal about this role). Evidence for another country never stands in for the job's: a GB
  // licence does not hide US hiring history for a US role. When no tier covers the job (or its
  // countries are unknown), current capability outranks hiring history, which outranks a lapsed
  // licence, as before.
  const jobCountryList = unique(input.jobCountries);
  const covers = (countries: readonly string[]) => countries.some((c) => jobCountryList.includes(c));
  const tiers: Array<[Sponsorship['companyCapability'], string[]]> = [
    ['licensed', licensed],
    ['historical', historical],
    ['previously_licensed', lapsed],
  ];
  const chosen = tiers.find(([, cs]) => cs.length && covers(cs)) ?? tiers.find(([, cs]) => cs.length);
  const companyCapability: Sponsorship['companyCapability'] = !company ? 'unknown' : (chosen?.[0] ?? 'none');
  const capabilityCountries = chosen?.[1] ?? [];
  const companyEvidence: EvidenceSpan[] = [];
  if (companyCapability === 'licensed')
    companyEvidence.push(syntheticSpan('company', `sponsorLicenceCountries: ${licensed.join(', ')}`));
  else if (companyCapability === 'historical')
    companyEvidence.push(
      syntheticSpan('company', `historicalSponsorshipCountries: ${historical.join(', ')}`),
    );
  else if (companyCapability === 'previously_licensed')
    companyEvidence.push(syntheticSpan('company', `previousLicenceCountries: ${lapsed.join(', ')}`));

  const base = { companyCapability, capabilityCountries };
  // Related content of the posting: the description (stated-value lines and mentions), the title
  // and the location (mentions only).
  const statements = findSponsorshipStatements(description, {
    jobCountries: input.jobCountries,
    layoutLineStarts: input.layoutLineStarts,
  });
  const title = input.title ?? '';
  const location = (input.locationTexts ?? []).join('\n');
  const stated = statements.filter(
    (s): s is SponsorshipStatement & { stance: 'yes' | 'no' } => s.stance !== 'mention',
  );
  // Description spans say which rendering their offsets point into (a720377 (1)).
  const span = (field: 'description' | 'title' | 'location', text: string) => (x: SponsorshipStatement) => {
    const e = spanOf(field, text, x.sentence.start, x.sentence.end);
    return field === 'description' && input.rendering ? { ...e, rendering: input.rendering } : e;
  };
  const mentionEvidence = [
    ...statements.filter((x) => x.stance === 'mention').map(span('description', description)),
    ...(title ? findSponsorshipStatements(title, { allowStated: false }).map(span('title', title)) : []),
    ...(location
      ? findSponsorshipStatements(location, { allowStated: false }).map(span('location', location))
      : []),
  ];

  // A stated value is a statement, never a verdict (012d041).
  const values = unique(stated.map((x) => x.stance));
  // Polarities conflict only where the keys' scopes overlap; a generic key overlaps every scope
  // (DECISION_LOG bc013e8 L3): "Skilled Worker: Yes" and "H-1B: No" do not contradict.
  const contradicts = stated.some(
    (a) => a.stance === 'yes' && stated.some((b) => b.stance === 'no' && scopesOverlap(a.scope, b.scope)),
  );
  // One flag per stated value and key scope, worded from the key (bc013e8 M4).
  const scopeKey = (x: SponsorshipStatement) => (x.scope ? [...x.scope].sort().join(',') : '*');
  const seen = new Set<string>();
  for (const line of stated) {
    const id = `${line.stance}|${scopeKey(line)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    flags.push({
      code: 'sponsorship_stated',
      message: `The posting states "${line.key ?? 'visa sponsorship'}: ${line.stance}" in a structured line${line.scope ? ` (${line.key} applies to ${line.scope.length > 3 ? 'the participating EU countries' : line.scope.join(', ')})` : ''}; a statement, not a verdict (only an operator can confirm it).`,
      severity: 'info',
      value: line.stance,
      ...(line.scope ? { scope: [...line.scope] } : {}),
      evidence: span('description', description)(line),
    });
  }
  if (contradicts)
    flags.push({
      code: 'sponsorship_conflict',
      message:
        'Structured lines of the description both offer and rule out sponsorship; human review needed.',
      severity: 'high',
    });
  else if (values.length && mentionEvidence.length)
    flags.push({
      code: 'sponsorship_mixed_statement',
      message:
        'The posting states sponsorship in a structured line and also has other sponsorship or right-to-work content.',
      severity: 'info',
    });
  if (mentionEvidence.length)
    flags.push({
      code: 'sponsorship_mentioned',
      message:
        'The posting mentions sponsorship, visas or the right to work; posting text is evidence, never a verdict.',
      severity: 'info',
    });

  // The role's stated "no" against the company's licence, where the licence covers the job — and,
  // for a country-specific key, where the key's scope overlaps the licence (bc013e8 M4).
  // scope ∩ licence ∩ job countries (bc013e8 L4): a Blue Card "no" for a Berlin + London job does
  // not touch a GB + NL licence.
  // Also against hiring history (DECISION_LOG "Sponsor register adapters" (5)).
  const historyCase = companyCapability === 'historical';
  const noAgainstLicence =
    (companyCapability === 'licensed' || historyCase) &&
    stated.some(
      (x) =>
        x.stance === 'no' &&
        (x.scope ?? input.jobCountries).some(
          (c) => capabilityCountries.includes(c) && input.jobCountries.includes(c),
        ),
    );
  const statedNoOverridesLicence = values.length === 1 && values[0] === 'no' && noAgainstLicence;
  if (statedNoOverridesLicence)
    flags.push({
      code: 'sponsorship_role_overrides_company',
      message: historyCase
        ? 'Company has sponsorship history but the posting states that this role does not offer sponsorship.'
        : 'Company holds a sponsor licence but the posting states that this role does not offer sponsorship.',
      severity: 'info',
    });

  // A stated value is a flag and evidence; it does not suppress company-level evidence: the
  // status follows the company axis (DECISION_LOG 8d96663 (5)).
  const postingEvidence = [...stated.slice(0, 3).map(span('description', description)), ...mentionEvidence];
  const postingBasis = contradicts
    ? 'description.conflict'
    : values.length
      ? 'description.stated'
      : mentionEvidence.length
        ? 'description.mention'
        : 'none';
  const jobCountries = unique(input.jobCountries);
  const unclear = (basis: string, evidence: EvidenceSpan[] = []): SponsorshipResult => ({
    sponsorship: {
      value: { status: 'unclear', roleStatement: 'none', ...base },
      // A stated value is a statement (low); otherwise nothing is known about the role.
      confidence: values.length ? 'low' : 'unknown',
      evidence: [...evidence, ...postingEvidence.slice(0, values.length ? 6 : 3)],
      basis,
    },
    flags,
  });
  if (companyCapability === 'previously_licensed') {
    const jobCountriesKnown = unique(input.jobCountries);
    const otherCountry =
      jobCountriesKnown.length > 0 && !capabilityCountries.some((c) => jobCountriesKnown.includes(c));
    flags.push({
      code: 'sponsor_licence_lapsed',
      message: otherCountry
        ? `The company's sponsor licence (${capabilityCountries.join(', ')}) is no longer listed, and it was for another country than the job's (${jobCountriesKnown.join(', ')}); it is not evidence that this role sponsors.`
        : `The company's sponsor licence (${capabilityCountries.join(', ')}) is no longer listed; it is past capability, not evidence that this role sponsors.`,
      severity: 'info',
    });
    return unclear('company.previousLicence', companyEvidence);
  }
  if ((companyCapability === 'licensed' || companyCapability === 'historical') && !jobCountries.length) {
    // Unknown stays unknown: a licence cannot be applied to a role whose countries are unknown
    // (plain "Remote", no location). The capability is recorded, the status is not claimed.
    flags.push({
      code: 'sponsor_capability_job_country_unknown',
      message: `Company holds a ${companyCapability === 'licensed' ? 'sponsor licence' : 'sponsorship history'} (${capabilityCountries.join(', ')}) but the job's countries are unknown, so it cannot be applied to this role.`,
      severity: 'info',
    });
    return unclear(
      companyCapability === 'licensed'
        ? 'company.sponsorLicence.job_country_unknown'
        : 'company.historicalSponsorship.job_country_unknown',
      companyEvidence,
    );
  }
  const relevant = (countries: string[]) => countries.some((c) => jobCountries.includes(c));
  if (companyCapability === 'licensed' || companyCapability === 'historical') {
    if (!relevant(capabilityCountries)) {
      flags.push({
        code: 'sponsor_capability_other_country',
        message: `Company sponsorship evidence (${capabilityCountries.join(', ')}) does not cover the job's countries (${jobCountries.join(', ')}).`,
        severity: 'info',
      });
      return unclear(postingBasis);
    }
    const licensedCase = companyCapability === 'licensed';
    // An application constraint (existing right to work where the capability applies) is in
    // tension with the capability: keep the tier, lower the confidence, say why (M11.1).
    const rtw = input.rightToWork;
    const rtwRegions = rtw?.regions ?? [];
    const rtwNamed = rtw ? [...rtw.countries, ...rtwRegions] : [];
    const coversCountry = (c: string) =>
      !!rtw && (rtw.countries.includes(c) || rtwRegions.some((r) => countriesOfRegion(r).includes(c)));
    const rtwCovered = capabilityCountries.filter(
      (c) => jobCountries.includes(c) && (!rtwNamed.length || coversCountry(c)),
    );
    const rtwTension = rtw?.required === true && rtwCovered.length > 0;
    if (rtwTension) {
      flags.push({
        code: 'right_to_work_required_with_sponsor_capability',
        message: `The role requires existing right to work (${rtwNamed.join(', ') || rtwCovered.join(', ')}) although the company ${licensedCase ? 'holds a sponsor licence' : 'has sponsorship history'} (${capabilityCountries.join(', ')}); sponsorship for this role is doubtful.`,
        severity: 'info',
      });
    }
    return {
      sponsorship: {
        value: {
          status: licensedCase ? 'company_capable' : 'historical_evidence',
          roleStatement: 'none',
          ...base,
        },
        // A stated "no" or contradictory stated values are in tension with the capability too.
        confidence: licensedCase && !rtwTension && !noAgainstLicence ? 'medium' : 'low',
        evidence: [...companyEvidence, ...postingEvidence.slice(0, values.length ? 6 : 3)],
        basis: licensedCase ? 'company.sponsorLicence' : 'company.historicalSponsorship',
      },
      flags,
    };
  }

  return unclear(postingBasis);
}

export type SponsorshipInterpretation = JobInterpretation['sponsorship'];
