/**
 * Employment vocabularies: employment types, work models, company stages, industries and
 * requirement categories. Enumerations mirror the Market employment contract and are asserted
 * equal by tests in `@aptamind/market`.
 */

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
  'apprenticeship',
  'freelance',
  'unclear',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * Ordered keyword rules for employment-type text (provider labels, titles, explicit sentences).
 * Specific types (internship, apprenticeship, freelance, temporary) precede generic ones.
 */
export const EMPLOYMENT_TYPE_RULES: ReadonlyArray<{ type: EmploymentType; pattern: RegExp }> = [
  {
    type: 'internship',
    pattern: /\b(?:internship|intern|working\s+student|werkstudent|placement\s+year)\b/i,
  },
  { type: 'apprenticeship', pattern: /\b(?:apprenticeship|apprentice)\b/i },
  { type: 'freelance', pattern: /\b(?:freelance|freelancer|self-employed)\b/i },
  {
    type: 'temporary',
    pattern:
      /\b(?:temporary|temp|seasonal|maternity\s+cover|paternity\s+cover|parental\s+leave\s+cover|interim)\b/i,
  },
  {
    type: 'contract',
    pattern:
      /\b(?:contract|contractor|fixed[\s-]term|b2b|inside\s+ir35|outside\s+ir35|day\s+rate|\d+[\s-]month\s+(?:contract|engagement)|consultancy\s+basis)\b/i,
  },
  { type: 'part_time', pattern: /\b(?:part[\s-]time|\d{1,2}\s*hours?\s+(?:per|a)\s+week|0\.\d\s*fte)\b/i },
  { type: 'full_time', pattern: /\b(?:full[\s-]time|permanent|perm|fte|regular\s+employee)\b/i },
];

export interface EmploymentTypeMatch {
  type: EmploymentType;
  matchedText: string;
  index: number;
}

/** All employment-type keywords present in a text (one per type, first occurrence). */
export function findEmploymentTypes(text: string): EmploymentTypeMatch[] {
  const out: EmploymentTypeMatch[] = [];
  for (const rule of EMPLOYMENT_TYPE_RULES) {
    const m = text.match(rule.pattern);
    if (m && m.index !== undefined) out.push({ type: rule.type, matchedText: m[0], index: m.index });
  }
  return out;
}

export const WORK_MODELS = ['remote', 'hybrid', 'onsite', 'unclear'] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

export const REMOTE_SCOPE_TYPES = [
  'worldwide',
  'region',
  'country',
  'selected_countries',
  'timezone',
  'unclear',
  'not_applicable',
] as const;

export const COMPANY_STAGES = [
  'startup',
  'scale_up',
  'mid_market',
  'enterprise',
  'public_sector',
  'non_profit',
] as const;
export type CompanyStage = (typeof COMPANY_STAGES)[number];

export const COMPANY_STAGE_RULES: ReadonlyArray<{ stage: CompanyStage; pattern: RegExp }> = [
  {
    stage: 'public_sector',
    pattern: /\b(?:government|public\s+sector|civil\s+service|council|nhs|ministry|agency)\b/i,
  },
  { stage: 'non_profit', pattern: /\b(?:non-?profit|not-for-profit|charity|ngo|foundation)\b/i },
  { stage: 'startup', pattern: /\b(?:start-?up|seed|pre-seed|series\s+a|early[\s-]stage)\b/i },
  { stage: 'scale_up', pattern: /\b(?:scale-?up|series\s+[b-e]|high-growth|hypergrowth|unicorn)\b/i },
  {
    stage: 'enterprise',
    pattern: /\b(?:enterprise|fortune\s+500|ftse\s+100|global\s+leader|publicly\s+traded|listed\s+on)\b/i,
  },
  { stage: 'mid_market', pattern: /\b(?:mid-?market|mid-?sized|sme)\b/i },
];

export const INDUSTRIES = [
  {
    code: 'software_saas',
    label: 'Software / SaaS',
    pattern: /\b(?:saas|software|platform|b2b\s+software)\b/i,
  },
  {
    code: 'fintech',
    label: 'Fintech & financial services',
    pattern: /\b(?:fintech|payments?|banking|bank|lending|insurtech|insurance|trading|crypto)\b/i,
  },
  {
    code: 'healthtech',
    label: 'Health & life sciences',
    pattern: /\b(?:health(?:care|tech)?|medical|clinical|biotech|pharma|life\s+sciences)\b/i,
  },
  {
    code: 'ecommerce_retail',
    label: 'E-commerce & retail',
    pattern: /\b(?:e-?commerce|retail|marketplace|consumer\s+goods)\b/i,
  },
  { code: 'edtech', label: 'Education', pattern: /\b(?:edtech|education|learning\s+platform|university)\b/i },
  {
    code: 'ai_ml',
    label: 'AI / ML',
    pattern: /\b(?:artificial\s+intelligence|machine\s+learning|generative\s+ai|llms?)\b/i,
  },
  { code: 'security', label: 'Cybersecurity', pattern: /\b(?:cyber\s?security|security\s+platform)\b/i },
  {
    code: 'gaming_media',
    label: 'Gaming & media',
    pattern: /\b(?:gaming|games|media|entertainment|streaming)\b/i,
  },
  {
    code: 'mobility_logistics',
    label: 'Mobility & logistics',
    pattern: /\b(?:logistics|mobility|transportation|delivery|automotive)\b/i,
  },
  {
    code: 'energy_climate',
    label: 'Energy & climate',
    pattern: /\b(?:energy|climate|renewables?|clean\s?tech|sustainability)\b/i,
  },
  {
    code: 'public_sector',
    label: 'Government & public sector',
    pattern: /\b(?:government|public\s+sector|govtech)\b/i,
  },
  {
    code: 'consulting_agency',
    label: 'Consulting & agency',
    pattern: /\b(?:consultancy|consulting|agency)\b/i,
  },
] as const;
export type IndustryCode = (typeof INDUSTRIES)[number]['code'];

/** Human languages recognised in language requirements. */
export const HUMAN_LANGUAGES = [
  'english',
  'german',
  'french',
  'spanish',
  'dutch',
  'italian',
  'portuguese',
  'polish',
  'arabic',
  'mandarin',
  'cantonese',
  'chinese',
  'japanese',
  'korean',
  'hindi',
  'swedish',
  'norwegian',
  'danish',
  'finnish',
  'russian',
  'ukrainian',
  'turkish',
  'hebrew',
  'greek',
  'czech',
  'romanian',
  'hungarian',
] as const;

/** Must stay in sync with the employment contract's REQUIREMENT_CATEGORIES. */
export const REQUIREMENT_CATEGORIES = [
  'skill',
  'experience',
  'education',
  'certification',
  'language',
  'authorization',
  'location',
  'soft_skill',
  'other',
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

/** Keyword rules per requirement category (ordered, first match wins; `skill` is decided by the skills dictionary). */
export const REQUIREMENT_CATEGORY_RULES: ReadonlyArray<{ category: RequirementCategory; pattern: RegExp }> = [
  {
    category: 'authorization',
    pattern:
      /\b(?:right\s+to\s+work|work(?:ing)?\s+(?:authori[sz]ation|permit|visa)|authori[sz]ed\s+to\s+work|eligib(?:le|ility)\s+to\s+work|visa|citizen(?:ship)?|security\s+clearance|sc\s+clearance|dv\s+clearance|clearance|green\s+card|permanent\s+resident)\b/i,
  },
  {
    category: 'location',
    pattern:
      /\b(?:based\s+in|located\s+in|reside|residing|live\s+within|commut(?:e|able|ing)|relocate|on-?site\s+in)\b/i,
  },
  {
    category: 'language',
    pattern: new RegExp(
      `\\b(?:(?:fluen(?:t|cy)|proficien(?:t|cy)|native|bilingual|business[\\s-]level|professional\\s+working)\\s+(?:(?:level|speaker|command)\\s+)?(?:in\\s+)?(?:(?:written|spoken|verbal)\\s+(?:and|&)\\s+(?:written|spoken|verbal)\\s+)?(?:${HUMAN_LANGUAGES.join('|')})|(?:${HUMAN_LANGUAGES.join('|')})\\s+(?:\\(?(?:fluent|native|C1|C2|B2)|speaker|language\\s+skills|proficiency|fluency|is\\s+(?:required|essential|a\\s+plus))|bilingual|native\\s+speaker)`,
      'i',
    ),
  },
  {
    category: 'education',
    pattern:
      /\b(?:degree|bachelor'?s?|master'?s|masters|ph\.?d|doctorate|bsc|msc|b\.s\.|m\.s\.|b\.a\.|mba|university|diploma|graduate\s+of|computer\s+science\s+or\s+(?:a\s+)?related\s+field)\b/i,
  },
  {
    category: 'certification',
    pattern:
      /\b(?:certifi(?:ed|cation|cate)|cissp|cism|oscp|pmp|cpa|acca|cima|cfa|aca|prince2|itil|ccna|ceh)\b/i,
  },
  {
    category: 'soft_skill',
    pattern:
      /\b(?:communication|communicator|collaborat\w*|team\s+player|self-?starter|self-?motivated|proactive|problem[\s-]solving|problem\s+solver|stakeholder|empath\w*|curious|curiosity|attention\s+to\s+detail|detail-oriented|growth\s+mindset|ownership|autonomy|autonomous|adaptab\w*|interpersonal|organi[sz]ational\s+skills|passion(?:ate)?|mentor\w*)\b/i,
  },
];
