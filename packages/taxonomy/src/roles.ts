/**
 * Role families, specialisations and seniority rules for job titles.
 *
 * Rules are ordered: the first matching rule wins, so more specific families (engineering
 * management, data, security, QA…) are listed before the generic software-engineering catch-all.
 */

export const ROLE_FAMILIES = [
  'software_engineering',
  'data_engineering',
  'data_science_ml',
  'data_analytics',
  'product_management',
  'design',
  'devops_sre',
  'security',
  'qa_testing',
  'engineering_management',
  'sales',
  'marketing',
  'customer_success',
  'operations',
  'finance',
  'hr_people',
  'legal',
  'other',
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export interface RoleFamilyRule {
  family: RoleFamily;
  pattern: RegExp;
}

/** Ordered: first match wins. */
export const ROLE_FAMILY_RULES: readonly RoleFamilyRule[] = [
  {
    family: 'engineering_management',
    pattern:
      /\b(?:engineering\s+manager|manager,?\s+(?:software\s+)?engineering|(?:director|head|vp|vice\s+president)\s+(?:of\s+)?(?:software\s+)?engineering|cto|chief\s+technology\s+officer|development\s+manager|engineering\s+(?:director|lead(?:er)?ship))\b/i,
  },
  {
    family: 'marketing',
    pattern:
      /\b(?:product\s+marketing|marketing|growth\s+marketer|seo|sem|content\s+(?:strategist|writer|marketer|manager)|brand\s+(?:manager|designer|lead)|demand\s+gen(?:eration)?|communications|copywriter|social\s+media|pr\s+manager|cmo)\b/i,
  },
  {
    family: 'design',
    pattern:
      /\b(?:designer|design\s+(?:lead|manager|director)|head\s+of\s+design|ux|ui\/ux|user\s+experience|user\s+researcher|ux\s+researcher|design\s+researcher|interaction\s+design|visual\s+design)\b/i,
  },
  {
    family: 'data_science_ml',
    pattern:
      /\b(?:machine\s+learning|ml|mlops|ai|data\s+scientist|data\s+science|research\s+scientist|applied\s+scientist|research\s+engineer|deep\s+learning|computer\s+vision|nlp|llm)\b/i,
  },
  {
    family: 'data_engineering',
    pattern:
      /\b(?:data\s+engineer(?:ing)?|analytics\s+engineer|etl|data\s+platform|big\s+data|data\s+architect|database\s+(?:engineer|administrator)|dba)\b/i,
  },
  {
    family: 'data_analytics',
    pattern:
      /\b(?:data\s+analyst|business\s+intelligence|bi\s+(?:analyst|developer|engineer)|analytics\s+(?:manager|lead)|insights\s+analyst|product\s+analyst)\b/i,
  },
  {
    family: 'security',
    pattern: /\b(?:security|appsec|infosec|penetration\s+tester|pentester|ciso|soc\s+analyst|cyber)\b/i,
  },
  {
    family: 'qa_testing',
    pattern:
      /\b(?:qa|quality\s+assurance|quality\s+engineer|test\s+(?:engineer|analyst|lead|automation)|sdet|tester|automation\s+tester)\b/i,
  },
  {
    family: 'devops_sre',
    pattern:
      /\b(?:devops|dev\s*ops|site\s+reliability|sre|platform\s+engineer(?:ing)?|infrastructure\s+engineer|cloud\s+(?:engineer|architect)|systems\s+(?:engineer|administrator)|sysadmin|release\s+engineer|build\s+engineer|devsecops)\b/i,
  },
  {
    family: 'customer_success',
    pattern:
      /\b(?:customer\s+success|customer\s+support|customer\s+experience|support\s+(?:engineer|specialist|agent|representative|lead|manager)|technical\s+support|client\s+success|implementation\s+(?:manager|specialist|consultant)|onboarding\s+specialist|customer\s+service)\b/i,
  },
  {
    family: 'sales',
    pattern:
      /\b(?:sales|account\s+executive|account\s+manager|business\s+development|bdr|sdr|solutions?\s+(?:engineer|consultant|architect)|pre-?sales|partnerships?\s+manager|revenue|cro)\b/i,
  },
  {
    family: 'product_management',
    pattern:
      /\b(?:product\s+(?:manager|owner|lead|director)|head\s+of\s+product|vp\s+(?:of\s+)?product|director\s+of\s+product|cpo|chief\s+product\s+officer|group\s+product\s+manager|apm|technical\s+product\s+manager)\b/i,
  },
  {
    family: 'legal',
    pattern:
      /\b(?:counsel|legal|lawyer|attorney|paralegal|solicitor|compliance|privacy\s+officer|general\s+counsel)\b/i,
  },
  {
    family: 'finance',
    pattern:
      /\b(?:finance|financial|accountant|accounting|controller|fp&a|treasury|tax|payroll|bookkeeper|cfo|auditor|billing)\b/i,
  },
  {
    family: 'hr_people',
    pattern:
      /\b(?:recruiter|recruiting|talent|people\s+(?:partner|operations|ops|team|business\s+partner)|hr|human\s+resources|hrbp|people\s+(?:manager|lead|director)|head\s+of\s+people|chief\s+people\s+officer|learning\s+and\s+development)\b/i,
  },
  {
    family: 'operations',
    pattern:
      /\b(?:operations|bizops|business\s+operations|chief\s+of\s+staff|program\s+manager|programme\s+manager|project\s+manager|office\s+manager|coo|supply\s+chain|logistics|procurement|revops)\b/i,
  },
  {
    family: 'software_engineering',
    pattern:
      /\b(?:software|developer|engineer|engineering|programmer|swe|frontend|front-end|front\s+end|backend|back-end|back\s+end|full[\s-]?stack|mobile|ios|android|web\s+developer|architect|tech\s+lead|coder)\b/i,
  },
];

export const SPECIALIZATIONS = [
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'ml',
  'data',
  'platform',
  'infrastructure',
  'embedded',
  'security',
  'devops',
  'sre',
  'cloud',
  'game',
  'blockchain',
  'test_automation',
  'analytics',
  'research',
  'product_design',
  'ux_research',
] as const;
export type Specialization = (typeof SPECIALIZATIONS)[number];

/** Ordered: first match wins. */
export const SPECIALIZATION_RULES: ReadonlyArray<{ specialization: Specialization; pattern: RegExp }> = [
  { specialization: 'fullstack', pattern: /\bfull[\s-]?stack\b/i },
  {
    specialization: 'frontend',
    pattern: /\b(?:front[\s-]?end|ui\s+engineer|web\s+developer|react|angular|vue)\b/i,
  },
  { specialization: 'backend', pattern: /\b(?:back[\s-]?end|server[\s-]side|api\s+engineer)\b/i },
  { specialization: 'mobile', pattern: /\b(?:mobile|ios|android|react\s+native|flutter)\b/i },
  {
    specialization: 'ml',
    pattern: /\b(?:machine\s+learning|ml|mlops|ai|deep\s+learning|computer\s+vision|nlp|llm)\b/i,
  },
  { specialization: 'research', pattern: /\b(?:research\s+(?:scientist|engineer)|researcher)\b/i },
  { specialization: 'sre', pattern: /\b(?:site\s+reliability|sre)\b/i },
  { specialization: 'devops', pattern: /\b(?:devops|dev\s*ops|devsecops)\b/i },
  { specialization: 'platform', pattern: /\bplatform\b/i },
  { specialization: 'infrastructure', pattern: /\b(?:infrastructure|infra)\b/i },
  { specialization: 'cloud', pattern: /\bcloud\b/i },
  { specialization: 'embedded', pattern: /\b(?:embedded|firmware)\b/i },
  { specialization: 'security', pattern: /\b(?:security|appsec|infosec)\b/i },
  { specialization: 'data', pattern: /\bdata\b/i },
  { specialization: 'analytics', pattern: /\banalytics\b/i },
  { specialization: 'game', pattern: /\b(?:game|gameplay|unity|unreal)\b/i },
  { specialization: 'blockchain', pattern: /\b(?:blockchain|web3|smart\s+contracts?|crypto)\b/i },
  {
    specialization: 'test_automation',
    pattern: /\b(?:test\s+automation|automation\s+(?:engineer|tester)|sdet)\b/i,
  },
  { specialization: 'ux_research', pattern: /\b(?:ux|user)\s+research(?:er)?\b/i },
  { specialization: 'product_design', pattern: /\bproduct\s+designer\b/i },
];

/** Must stay in sync with the employment contract's SENIORITY_LEVELS (checked by a test in @aptamind/market). */
export const SENIORITY_LEVELS = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'vp',
  'executive',
  'unclear',
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

/**
 * Ordered seniority rules (first match wins). "Manager" is only a seniority for people-management
 * titles: a "Product Manager" or "Account Manager" is an individual contributor.
 */
export const SENIORITY_RULES: ReadonlyArray<{ level: SeniorityLevel; pattern: RegExp }> = [
  {
    level: 'intern',
    pattern: /\b(?:intern|internship|working\s+student|werkstudent|placement\s+student|co-?op\s+student)\b/i,
  },
  {
    level: 'executive',
    pattern:
      /\b(?:chief\s+\w+(?:\s+\w+)?\s+officer|ceo|cto|cfo|coo|cpo|cmo|ciso|cro|president|founder|co-founder)\b/i,
  },
  { level: 'vp', pattern: /\b(?:vp|vice\s+president|svp|evp|avp)\b/i },
  { level: 'director', pattern: /\b(?:director|head\s+of)\b/i },
  { level: 'principal', pattern: /\bprincipal\b/i },
  {
    level: 'staff',
    pattern: /\bstaff\s+(?:\w+\s+)?(?:engineer|developer|scientist|designer|architect|analyst)\b/i,
  },
  {
    level: 'manager',
    pattern:
      /\b(?:engineering|development|delivery|team|people|general|line|design|data\s+science|analytics|support|sales|marketing)\s+manager\b|\bmanager,?\s+(?:software\s+)?engineering\b|\bmanager\s+of\b/i,
  },
  { level: 'lead', pattern: /\b(?:lead|tech\s+lead|team\s+lead|technical\s+lead)\b/i },
  { level: 'senior', pattern: /\b(?:senior|sr\.?|snr\.?)(?=\s|$|[^\p{L}])/iu },
  {
    level: 'junior',
    pattern:
      /\b(?:junior|jr\.?|graduate|grad|entry[\s-]level|associate(?!\s+(?:director|vp|vice|principal)))(?=\s|$|[^\p{L}])/iu,
  },
  { level: 'mid', pattern: /\b(?:mid[\s-]?level|mid[\s-]?senior|intermediate|mid)\b/i },
];

export interface SeniorityMatch {
  level: SeniorityLevel;
  matchedText: string;
  index: number;
}

/** Seniority from a title, or null when the title carries no seniority keyword. */
export function classifySeniority(title: string): SeniorityMatch | null {
  for (const rule of SENIORITY_RULES) {
    const m = title.match(rule.pattern);
    if (m && m.index !== undefined) return { level: rule.level, matchedText: m[0], index: m.index };
  }
  return null;
}

export interface RoleFamilyMatch {
  family: RoleFamily;
  matchedText: string;
  index: number;
}

/** Role family from a title, or null when nothing matches. */
export function classifyRoleFamily(title: string): RoleFamilyMatch | null {
  for (const rule of ROLE_FAMILY_RULES) {
    const m = title.match(rule.pattern);
    if (m && m.index !== undefined) return { family: rule.family, matchedText: m[0], index: m.index };
  }
  return null;
}

/** Specialisation from a title, or null. */
export function classifySpecialization(
  title: string,
): { specialization: Specialization; matchedText: string; index: number } | null {
  for (const rule of SPECIALIZATION_RULES) {
    const m = title.match(rule.pattern);
    if (m && m.index !== undefined)
      return { specialization: rule.specialization, matchedText: m[0], index: m.index };
  }
  return null;
}

/** Default department for a role family (used when the provider supplies none). */
export const FAMILY_DEPARTMENTS: Readonly<Record<RoleFamily, string | null>> = {
  software_engineering: 'engineering',
  data_engineering: 'data',
  data_science_ml: 'data',
  data_analytics: 'data',
  product_management: 'product',
  design: 'design',
  devops_sre: 'engineering',
  security: 'security',
  qa_testing: 'engineering',
  engineering_management: 'engineering',
  sales: 'sales',
  marketing: 'marketing',
  customer_success: 'customer_success',
  operations: 'operations',
  finance: 'finance',
  hr_people: 'people',
  legal: 'legal',
  other: null,
};
