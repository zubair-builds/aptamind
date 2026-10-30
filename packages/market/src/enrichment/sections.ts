import { lines, sentencesOf, stripBullet } from './text';
import type { Segment } from './text';

/**
 * Description section detection. Job descriptions (after `htmlToText`) are mostly heading + list
 * blocks; recognising the heading tells us how to read the items ("Nice to have" → preferred,
 * "What you'll do" → responsibilities, "Benefits" → not requirements).
 */

export type SectionKind = 'must_have' | 'requirements' | 'preferred' | 'responsibilities' | 'stack' | 'other';

export interface Section {
  kind: SectionKind;
  /** Heading text as written (without trailing colon); null for the untitled preamble. */
  heading: string | null;
  /** Items (bullets or sentences) with offsets into the description; bullet markers stripped. */
  items: Array<Segment & { bullet: boolean }>;
}

const APOS = "(?:'|’)?";
const HEADING_RULES: ReadonlyArray<{ kind: SectionKind; pattern: RegExp }> = [
  {
    kind: 'must_have',
    pattern:
      /^(?:must[\s-]haves?|must\s+have\s+(?:skills|requirements|qualifications)|essentials?|essential\s+(?:skills|requirements|criteria|qualifications|experience)|minimum\s+(?:qualifications|requirements)|basic\s+qualifications|required\s+(?:skills|qualifications|experience)|non[\s-]negotiables?|hard\s+requirements|requirements\s*\(must[\s-]have\))$/,
  },
  {
    kind: 'preferred',
    pattern: new RegExp(
      `^(?:nice[\\s-]to[\\s-]haves?|nice\\s+to\\s+have\\s+(?:skills|requirements)|bonus(?:\\s+points?)?(?:\\s+(?:if|for).*)?|preferred(?:\\s+(?:qualifications|skills|experience|requirements))?|desirable(?:\\s+(?:skills|criteria|experience))?|desired\\s+(?:skills|qualifications)|(?:it${APOS}s\\s+)?(?:a\\s+)?plus(?:es)?|pluses|good\\s+to\\s+have|extra\\s+credit|even\\s+better(?:\\s+if.*)?|it\\s+would\\s+be\\s+great\\s+if.*|ideally.*|additional\\s+(?:qualifications|skills)|what\\s+would\\s+make\\s+you\\s+stand\\s+out|you\\s+might\\s+also\\s+have|bonus\\s+skills|what\\s+sets\\s+you\\s+apart)$`,
    ),
  },
  {
    kind: 'requirements',
    pattern: new RegExp(
      `^(?:requirements|job\\s+requirements|role\\s+requirements|what\\s+you${APOS}ll\\s+need|what\\s+you\\s+will\\s+need|what\\s+you\\s+need(?:\\s+to\\s+succeed)?|what\\s+we${APOS}re\\s+looking\\s+for|what\\s+we\\s+are\\s+looking\\s+for|who\\s+you\\s+are|about\\s+you|you\\s+have|you\\s+should\\s+have|you\\s+will\\s+have|you${APOS}ll\\s+have|qualifications|skills(?:\\s+(?:and|&)\\s+(?:experience|qualifications))?|experience(?:\\s+(?:and|&)\\s+skills)?|your\\s+(?:profile|experience|skills|background|qualifications)|key\\s+(?:skills|requirements|qualifications)|what\\s+you${APOS}ll\\s+bring|what\\s+you\\s+bring|what\\s+we\\s+expect|(?:the\\s+)?ideal\\s+candidate.*|you\\s+are|to\\s+be\\s+successful.*|we${APOS}d\\s+love\\s+to\\s+hear\\s+from\\s+you\\s+if.*|is\\s+this\\s+you|profile|who\\s+we${APOS}re\\s+looking\\s+for|candidate\\s+profile)$`,
    ),
  },
  {
    kind: 'responsibilities',
    pattern: new RegExp(
      `^(?:responsibilities|key\\s+responsibilities|your\\s+responsibilities|what\\s+you${APOS}ll\\s+do|what\\s+you\\s+will\\s+do|what\\s+you${APOS}ll\\s+be\\s+doing|what\\s+you\\s+will\\s+be\\s+doing|the\\s+role|your\\s+role|about\\s+the\\s+role|role\\s+overview|in\\s+this\\s+role(?:,?\\s+you\\s+will)?|day[\\s-]to[\\s-]day|a\\s+day\\s+in\\s+the\\s+life|your\\s+impact|what\\s+you${APOS}ll\\s+work\\s+on|the\\s+job|duties|key\\s+duties|your\\s+mission|the\\s+opportunity|what\\s+you${APOS}ll\\s+achieve)$`,
    ),
  },
  {
    kind: 'stack',
    pattern:
      /^(?:(?:our\s+)?tech(?:nology)?\s+stack|our\s+stack|the\s+stack|tools\s+we\s+use|technologies\s+we\s+use)$/,
  },
  {
    kind: 'other',
    pattern:
      /^(?:about\s+us|about\s+the\s+company|about\s+[\w .&-]{1,40}|who\s+we\s+are|benefits|perks|perks\s+(?:and|&)\s+benefits|benefits\s+(?:and|&)\s+perks|what\s+we\s+offer|what\s+we\s+provide|why\s+join(?:\s+us)?|why\s+work\s+with\s+us|compensation(?:\s+(?:and|&)\s+benefits)?|salary|how\s+to\s+apply|our\s+values|equal\s+opportunit.*|diversity.*|location|the\s+team|about\s+the\s+team|interview\s+process|our\s+process|hiring\s+process|next\s+steps)$/,
  },
];

/** Canonical form of a heading line for matching (lower-case, no markdown/emoji/trailing colon). */
export function headingKey(text: string): string {
  return text
    .replace(/^[#*_\s\p{Extended_Pictographic}️]+|[*_:!?.\s\p{Extended_Pictographic}️]+$/gu, '')
    .replace(/’/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

export function classifyHeading(text: string): SectionKind | null {
  const key = headingKey(text);
  if (!key || key.length > 80) return null;
  for (const rule of HEADING_RULES) if (rule.pattern.test(key)) return rule.kind;
  return null;
}

/** An unrecognised line that is still clearly a heading (ends with ":", is ALL CAPS or **bold**). */
function looksLikeHeading(text: string): boolean {
  if (text.length > 60 || /^[-•*·]\s/.test(text)) return false;
  if (/^\*\*[^*]+\*\*:?$/.test(text) || /^#{1,6}\s/.test(text)) return true;
  if (/:$/.test(text) && text.split(/\s+/).length <= 8) return true;
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && text.split(/\s+/).length <= 6;
}

/** Splits a description into titled sections with their items. */
export function detectSections(description: string): Section[] {
  const out: Section[] = [{ kind: 'other', heading: null, items: [] }];
  const current = () => out[out.length - 1] as Section;
  for (const line of lines(description)) {
    const inline = line.text.match(/^([^:]{2,60}):\s+(\S.*)$/);
    const headingKind = classifyHeading(line.text);
    if (headingKind && !/^[-•*·]\s/.test(line.text)) {
      out.push({
        kind: headingKind,
        heading: headingKey(line.text) ? line.text.replace(/:\s*$/, '') : null,
        items: [],
      });
      continue;
    }
    if (inline && inline[1] && inline[2]) {
      const inlineKind = classifyHeading(inline[1]);
      if (inlineKind) {
        out.push({ kind: inlineKind, heading: inline[1], items: [] });
        const offset = line.text.length - inline[2].length;
        const rest: Segment = { text: inline[2], start: line.start + offset, end: line.end };
        for (const s of sentencesOf(rest)) current().items.push({ ...s, bullet: false });
        continue;
      }
    }
    if (looksLikeHeading(line.text)) {
      out.push({ kind: 'other', heading: line.text.replace(/:\s*$/, ''), items: [] });
      continue;
    }
    const item = stripBullet(line);
    if (item.bullet) {
      current().items.push(item);
    } else {
      for (const s of sentencesOf(line)) current().items.push({ ...s, bullet: false });
    }
  }
  return out.filter((s) => s.items.length > 0 || s.heading !== null);
}
