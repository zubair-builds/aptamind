/**
 * Personal-data header guard for company directory uploads (DECISION_LOG "Company directory
 * import hardening"; PR #27 re-verification #3). A header name is normalised first — zero-width
 * characters stripped, accent-folded, split on camelCase and letter/digit boundaries and on
 * anything that is not a letter or digit, lower-cased — into tokens ("PhoneNumber" → phone,
 * number; "Tel1" → tel, 1; "Téléphone" → telephone) and their joined letters ("phonenumber").
 * A header is personal data when:
 *  - the joined letters contain a strong substring (email, phone, mobile, birth, passport,
 *    contactno, keycontact, ansprechpartner, …), which catches run-together and lower-case
 *    spellings ("phonenumber", "contactemail", "telno");
 *  - a token (singularised) is a personal or people-role word (tel, cell, contact, director,
 *    owner, ceo, handy, kontakt, inhaber, gérant, utr, …), or the joined letters START or END
 *    with one (3+ letters: "ownername", "mobno", "directorname"), or two tokens form a known
 *    pair ("first name", "ni number", "ph no");
 *  - the tokens spell d-o-b ("D.O.B").
 * Allowed: headcount columns (Employees, Employee count/range, Number of employees (2023),
 * Employees (UK), Headcount), postcode, and a short list of legitimate company headers that
 * would otherwise match (Companies House BasicCompanyData `LimitedPartnerships.NumGenPartners` /
 * `NumLimPartners`, `NI Company Number`, `Email domain`, `Mobile app`, `Automobile sector`).
 * Company switchboard numbers ("Company phone") are refused: the import reads no phone field, and
 * a phone column cannot be told apart from a person's number.
 */

const STRONG_SUBSTRINGS = [
  'email',
  'phone',
  'mobile',
  'birth',
  'passport',
  'linkedin',
  'nationalinsurance',
  'socialsecurity',
  'whatsapp',
  'wechat',
  'snapchat',
  'skype',
  'instagram',
  'facebook',
  'twitter',
  'tiktok',
  'telegram',
  'username',
  'iban',
  'bankaccount',
  'sortcode',
  'courriel',
  'correo',
  'geburtsdatum',
  'vorname',
  'nachname',
  'telefon',
  'telno',
  'mobno',
  'contactno',
  'contactnumber',
  'contactperson',
  'keycontact',
  'ownername',
  'directorname',
  'kontakt',
  'ansprechpartner',
  'geschaftsfuhrer',
  'residentialaddress',
  'homeaddress',
  'firstname',
  'lastname',
  'surname',
  'forename',
  'fullname',
  'givenname',
  'familyname',
  'middlename',
  'maidenname',
  'dateofbirth',
  'nationality',
  'ethnicity',
  'religion',
  'decisionmaker',
  'soletrader',
  'salutation',
  'voornaam',
  'achternaam',
  'cognome',
  'apellido',
  'nazwisko',
  'contatto',
  'hiringlead',
  'hiringmanager',
  'talentlead',
  // re-verification #5 (M-6)
  'chiefexecutive',
  'legalrepresentative',
  'representantlegal',
  'salesrep',
  'accountexec',
  'teamlead',
  'boardmember',
  'registeredagent',
  'nationalid',
  'taxfilenumber',
  'codicefiscale',
  'steuerid',
  'aadhaar',
  'celular',
  'cellulare',
  'telefoon',
  'puhelin',
  'sahkoposti',
  'mailadresse',
  'naissance',
  'nacimiento',
  'geboortedatum',
  'privateaddress',
  'wohnadresse',
  'adressepersonnelle',
  'github',
  'discord',
];

/**
 * Personal or people-role tokens (5+ letters): matched as a token and as a prefix or suffix of
 * the joined letters ("ownername", "directorname", "chairman").
 */
const PERSONAL_TOKENS = [
  'handy',
  'portable',
  'movil',
  'contact',
  'person',
  'personal',
  'owner',
  'proprietor',
  'inhaber',
  'founder',
  'cofounder',
  'director',
  'dirigeant',
  'gerant',
  'manager',
  'partner',
  'secretary',
  'officer',
  'signatory',
  'shareholder',
  'employee', // except headcount and role-count headers
  'gender',
  'prenom',
  'chair',
  'president',
  'recruiter',
  'principal',
  'trustee',
  'treasurer',
  'nominee',
  'directeur',
  'directrice',
  'eigentumer',
  'proprietaire',
  'bestuurder',
  'vorstand',
  'spouse',
  'headhunter',
  'applicant',
  'candidate',
  'attendee',
  'interviewer',
];
const PERSONAL_TOKEN_SET = new Set(PERSONAL_TOKENS);

/**
 * Short personal tokens: matched as a whole token, or as a prefix of the joined letters only when
 * the rest is empty, a number/name suffix or digits ("TelNo", "mobno", "Tel1", "Faxnummer") —
 * never as a suffix or with other text ("Hotel", "Telecoms", "Mailing address", "Percentage").
 */
const SHORT_TOKENS = new Set([
  'tel',
  'tlf',
  'mob',
  'cell',
  'fax',
  'mail',
  'utr',
  'ceo',
  'dob',
  'ssn',
  'nino',
  'age',
  'sex',
  'md',
  'ni',
  'ph',
  'attn',
  'fao',
  'insta',
  // re-verification #5 (M-6): roles, national ids, phone words, social
  'cto',
  'cfo',
  'coo',
  'cmo',
  'chro',
  'vp',
  'psc',
  'poc',
  'pan',
  'sin',
  'nif',
  'dni',
  'cpf',
  'bsn',
  'pesel',
  'gsm',
  'natel',
  'mobil',
  'mobiel',
  'epost',
  'handle',
  'xing',
  'slack',
  'pdg',
]);
const SHORT_SUFFIXES = new Set([
  '',
  'no',
  'nr',
  'num',
  'nos',
  'number',
  'numbers',
  'nummer',
  'numero',
  'ephone',
  'efon',
  'efono',
  'name',
  'names',
  'id',
  'address',
  'addresses',
]);

const PERSONAL_PAIRS: Array<[string, string]> = [
  ['first', 'name'],
  ['last', 'name'],
  ['given', 'name'],
  ['family', 'name'],
  ['middle', 'name'],
  ['full', 'name'],
  ['owner', 'name'],
  ['employee', 'name'],
  ['staff', 'name'],
  ['contact', 'name'],
  ['contact', 'person'],
  ['key', 'contact'],
  ['home', 'address'],
  ['residential', 'address'],
  ['national', 'insurance'],
  ['social', 'security'],
  ['id', 'card'],
  ['ni', 'number'],
  ['ni', 'no'],
  ['ph', 'no'],
  ['linked', 'in'],
  ['e', 'mail'],
  ['care', 'of'],
  ['head', 'of'],
  ['decision', 'maker'],
  ['sole', 'trader'],
  ['hiring', 'lead'],
  ['hiring', 'manager'],
  ['talent', 'lead'],
  ['for', 'attention'],
];

/**
 * Legitimate company headers that would otherwise match, as normalised singular tokens joined by
 * spaces (digits dropped).
 */
const EXEMPT_HEADERS = new Set([
  'limited partnership num gen partner', // Companies House BasicCompanyData
  'limited partnership num lim partner',
  'num gen partner',
  'num lim partner',
  'ni company number',
  'ni company no',
  'ni registered number',
  'email domain',
  'e mail domain',
  'mobile app',
  'mobile application',
  'automobile sector',
  'partnership',
  'partnership type',
  'ownership',
  'ownership type',
  'contact page',
  'contact page url',
  'contact url',
  'contact us page',
  'contact us url',
  'mailing address',
  // re-verification #5 Low over-refusals
  'principal activity',
  'principal place of business',
  'company age',
  'age year',
  'owner type',
  'partner type',
  'channel partner',
  'personalisation',
  'personalization',
  // re-verification #6 Lows: plausible mapped company headers
  'principal office city',
  'company linkedin url',
  'company linked in url',
  'owner company',
]);

/** Exact headers that are personal although no single token or pair says so. */
const PERSONAL_HEADERS = new Set(['id number', 'id no', 'id nr', 'x handle', 'e post']);

/** Words that may qualify a headcount header: `Employees (UK)`, `Employee range`, `Number of employees (2023)`. */
const HEADCOUNT_QUALIFIERS = new Set([
  'of',
  'the',
  'no',
  'number',
  'count',
  'total',
  'estimated',
  'estimate',
  'approx',
  'approximate',
  'range',
  'band',
  'size',
  'uk',
  'global',
  'worldwide',
  'group',
  'fte',
  'full',
  'time',
  'equivalent',
  'latest',
  'current',
  'year',
  'headcount',
  'growth',
]);

/** Role words a count header may name: `Number of directors`, `Director count`. */
const ROLE_WORDS = new Set([
  'director',
  'founder',
  'cofounder',
  'contact',
  'employee',
  'officer',
  'partner',
  'shareholder',
  'manager',
  'staff',
  'person',
  'owner',
  'secretary',
  'signatory',
  'associated',
  'active',
  'current',
  'total',
  'the',
  'of',
]);

/**
 * A count of people in a role — `Number of directors`, `No. of founders`, `Director count`,
 * `Number of Associated Contacts` — is company data, not a person.
 */
function isRoleCount(tokens: string[]): boolean {
  const t = tokens.filter((w) => !/^\d+$/.test(w));
  const countWord =
    t.includes('count') || t.includes('total') || (['number', 'no', 'num'].includes(t[0]!) && t[1] === 'of');
  if (!countWord) return false;
  const rest = t.filter(
    (w, k) => !['count', 'total'].includes(w) && !(k <= 1 && ['number', 'no', 'num', 'of'].includes(w)),
  );
  return (
    rest.length > 0 && rest.every((w) => ROLE_WORDS.has(w)) && rest.some((w) => w !== 'of' && w !== 'the')
  );
}

/** Headcount headers: `Employees`, `Employee count`, `Number of employees (2023)`, `Headcount`. */
function isHeadcount(tokens: string[]): boolean {
  const t = tokens.filter((w) => !HEADCOUNT_QUALIFIERS.has(w) && !/^\d+$/.test(w));
  return t.length === 1 && (t[0] === 'employee' || t[0] === 'headcount' || t[0] === 'staff');
}

const IRREGULAR_SINGULAR: Record<string, string> = { people: 'person', staff: 'staff', persons: 'person' };

function singular(word: string): string {
  if (IRREGULAR_SINGULAR[word]) return IRREGULAR_SINGULAR[word]!;
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The normalised tokens of a header name (see the guard above), singularised. */
export function headerWords(column: string): string[] {
  return headerTokens(column).map(singular);
}

function headerTokens(column: string): string[] {
  return column
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether a header name denotes personal data (such a file is refused before storage). */
export function isPersonalDataColumn(column: string): boolean {
  const tokens = headerWords(column);
  const phrase = tokens.filter((t) => !/^\d+$/.test(t)).join(' ');
  if (EXEMPT_HEADERS.has(phrase)) return false;
  if (PERSONAL_HEADERS.has(phrase)) return true;
  // Joined letters of the tokens as written (not singularised: "WhatsApp" → "whatsapp").
  const joined = headerTokens(column)
    .filter((t) => /\p{L}/u.test(t))
    .join('');
  const stems = [joined, joined.replace(/s$/, '')];
  if (STRONG_SUBSTRINGS.some((s) => joined.includes(s))) return true;
  if (/(?:^| )d o b(?: |$)/.test(tokens.join(' '))) return true; // "D.O.B", "d/o/b"
  for (let i = 0; i + 1 < tokens.length; i++)
    if (PERSONAL_PAIRS.some(([a, b]) => tokens[i] === a && tokens[i + 1] === b)) return true;
  if (isHeadcount(tokens) || isRoleCount(tokens)) return false;
  if (tokens.some((t) => PERSONAL_TOKEN_SET.has(t) || SHORT_TOKENS.has(t))) return true;
  if (PERSONAL_TOKENS.some((t) => stems.some((j) => j.startsWith(t) || j.endsWith(t)))) return true;
  // Short tokens: a prefix with nothing, a number/name suffix or digits after it.
  const letters = headerTokens(column).join('');
  for (const t of SHORT_TOKENS) {
    if (!letters.startsWith(t)) continue;
    const rest = letters.slice(t.length);
    if (SHORT_SUFFIXES.has(rest) || /^\d+$/.test(rest) || SHORT_SUFFIXES.has(rest.replace(/\d+$/, '')))
      return true;
  }
  return false;
}
