import { load } from 'cheerio';
import { lines, type Segment } from './text';

/**
 * HTML → plain text for job descriptions.
 *
 * Keeps the structure the interpreter relies on: headings on their own lines (with a blank line
 * before), list items as "- " lines (indented when nested), paragraphs separated by blank lines.
 * Scripts/styles are dropped and entities decoded. Provider payloads that arrive entity-escaped
 * (Greenhouse returns "&lt;p&gt;…") are unescaped first.
 */

/** Structural view of the domhandler nodes cheerio produces (cheerio does not re-export their types). */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'svg',
  'iframe',
  'object',
  'button',
  'form',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/**
 * The plain-flow elements a sponsorship statement line may come from (DECISION_LOG 5a13fed,
 * 7f01fe5): text anywhere else — tables, ARIA grids, `s`/`strike`/`del`/`ins`, `mark`, links,
 * `details`, svg/button/object/iframe, any unknown element — is at most a mention. `mark` stays outside: it is not on the ruling's
 * list, and highlighting is editorial markup (search hits, diffs) rather than the posting's own
 * statement; the cost is recall only.
 */
const STATEMENT_CONTEXT = new Set([
  'html',
  'body',
  'section',
  'article',
  'div',
  'p',
  'li',
  'ul',
  'ol',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'br',
  ...HEADINGS,
]);

/** Attributes that never take a line out of the statement context (7f01fe5). */
const NEUTRAL_ATTRIBUTES = new Set(['lang', 'dir']);

/**
 * The closed set of inert `style` declarations real editors emit (DECISION_LOG bc013e8), matched
 * as whole normalised values — no cascade, no computed values, nothing else interpreted. Colour,
 * font-size, display, visibility, text-decoration, opacity, position and everything not listed
 * still take the line out.
 */
const NEUTRAL_DECLARATIONS = new Set([
  'min-height:1.5em', // Ashby paragraphs
  'font-weight:400', // Greenhouse / Google Docs spans
  'font-weight:700',
  'font-weight:normal',
  'font-weight:bold',
  'text-align:left', // TinyMCE
  'text-align:start',
  'text-align:justify',
  'text-align:inherit',
  'list-style-type:disc',
  'list-style-type:decimal',
]);
/** Provider-owned wrapper classes (Greenhouse `content-intro` / `content-conclusion`). */
const NEUTRAL_CLASSES = new Set(['content-intro', 'content-conclusion']);

/** Whether a `style` value is only inert declarations (split on `;`, lowercased, no whitespace). */
function neutralStyle(style: string): boolean {
  const declarations = style
    .split(';')
    .map((d) => d.toLowerCase().replace(/\s+/g, ''))
    .filter((d) => d.length > 0);
  return declarations.every((d) => NEUTRAL_DECLARATIONS.has(d));
}

function neutralAttribute(name: string, value: string): boolean {
  const key = name.toLowerCase();
  if (NEUTRAL_ATTRIBUTES.has(key)) return true;
  if (key === 'style') return neutralStyle(value);
  if (key === 'class') {
    const tokens = value.split(/\s+/).filter(Boolean);
    return tokens.every((t) => NEUTRAL_CLASSES.has(t));
  }
  return false;
}

/**
 * Whether an element takes its line out of the statement context (DECISION_LOG 7f01fe5,
 * bc013e8): a tag not on the allowlist, or any attribute that is not neutral — `lang` / `dir`, a
 * `style` made only of listed inert declarations, a `class` of listed provider wrappers. An
 * attribute-free `hr` is a neutral boundary.
 */
function outsideStatementContext(name: string, attribs: Record<string, string> | undefined): boolean {
  const entries = Object.entries(attribs ?? {});
  if (name === 'hr') return entries.length > 0;
  if (!STATEMENT_CONTEXT.has(name)) return true;
  return entries.some(([k, v]) => !neutralAttribute(k, v));
}
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
  'fieldset',
  'body',
  'html',
]);

class TextBuilder {
  private readonly out: string[] = [];
  private line = '';
  private pendingBlank = false;
  /**
   * Nesting depth of elements outside the statement context (not allowlisted, hidden, struck or
   * with a `role`) around the current position (DECISION_LOG 5a13fed).
   */
  restrictedDepth = 0;
  /** Whether the current line holds text from outside the statement context. */
  private lineRestricted = false;
  /** A restricted element at the boundary before the next line with text marks that line. */
  private pendingRestricted = false;
  /** Characters of text rendered so far (to tell empty elements from ones holding text). */
  textChars = 0;
  /** Per rendered (non-empty) line, in order: whether it holds such text. */
  readonly restrictedLines: boolean[] = [];

  /** A restricted element starts here: it overlaps the current line, or the next one. */
  markEntry(): void {
    if (this.line.trim()) this.lineRestricted = true;
    else this.pendingRestricted = true;
  }

  /**
   * An EMPTY restricted element (a `<br>`, an empty `<p>` / `<span>`) ends here: it sits at the
   * boundary of the line it ended and of the next one — both are restricted.
   */
  markEmptyBoundary(): void {
    if (this.line.trim()) this.lineRestricted = true;
    else if (this.restrictedLines.length) this.restrictedLines[this.restrictedLines.length - 1] = true;
    this.pendingRestricted = true;
  }

  inline(text: string): void {
    const collapsed = text.replace(/[\s\u00a0]+/g, ' ');
    if (!collapsed.trim() && !this.line) return;
    if (collapsed.trim()) {
      this.textChars += collapsed.trim().length;
      if (this.restrictedDepth > 0 || this.pendingRestricted) this.lineRestricted = true;
      this.pendingRestricted = false;
    }
    if (this.pendingBlank && !this.line) {
      if (this.out.length && this.out[this.out.length - 1] !== '') this.out.push('');
      this.pendingBlank = false;
    }
    if (!this.line) {
      this.line = collapsed.trimStart();
    } else if (this.line.endsWith(' ') && collapsed.startsWith(' ')) {
      this.line += collapsed.slice(1);
    } else {
      this.line += collapsed;
    }
  }

  /** Ends the current line (if any). */
  newline(): void {
    // Keep leading indentation (nested list markers); only drop trailing spaces.
    if (this.line.trim()) {
      this.out.push(this.line.trimEnd());
      this.restrictedLines.push(this.lineRestricted);
    }
    this.line = '';
    this.lineRestricted = false;
  }

  /** Ends the current line and requests a blank line before the next content. */
  paragraph(): void {
    this.newline();
    this.pendingBlank = true;
  }

  /** Starts a line with a literal prefix (bullet markers) that inline whitespace collapsing must not eat. */
  startLine(prefix: string): void {
    this.newline();
    if (this.pendingBlank && this.out.length && this.out[this.out.length - 1] !== '') this.out.push('');
    this.pendingBlank = false;
    this.line = prefix;
  }

  toString(): string {
    this.newline();
    return this.out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

function walk(node: DomNode, b: TextBuilder, listDepth: number): void {
  const type = String(node.type);
  if (type === 'text') {
    b.inline(node.data ?? '');
    return;
  }
  if (type !== 'tag' && type !== 'root') return;
  const name = type === 'tag' ? (node.name ?? '').toLowerCase() : 'root';
  if (SKIP.has(name)) {
    // Skipped (svg, button, object, iframe, …): not rendered, but it still sits in its line
    // (7f01fe5 L1).
    if (type === 'tag' && name !== 'head') b.markEmptyBoundary();
    return;
  }
  const children = node.children ?? [];
  // Every element overlapping a line — ancestors, descendants, empty or line-breaking ones at
  // its boundary — must be in the statement context (5a13fed, 7f01fe5); the rendering itself is
  // unchanged.
  if (type === 'tag' && outsideStatementContext(name, node.attribs)) {
    b.markEntry();
    const before = b.textChars;
    b.restrictedDepth += 1;
    try {
      dispatch(name, children, b, listDepth);
    } finally {
      b.restrictedDepth -= 1;
    }
    if (b.textChars === before) b.markEmptyBoundary();
    return;
  }
  dispatch(name, children, b, listDepth);
}

function dispatch(name: string, children: DomNode[], b: TextBuilder, listDepth: number): void {
  const recurse = (depth: number) => {
    for (const child of children) walk(child, b, depth);
  };

  if (name === 'br') {
    b.newline();
    return;
  }
  if (name === 'hr') {
    b.paragraph();
    return;
  }
  if (name === 'li') {
    b.startLine(`${'  '.repeat(Math.max(0, listDepth - 1))}- `);
    recurse(listDepth);
    b.newline();
    return;
  }
  if (name === 'ul' || name === 'ol') {
    b.newline();
    recurse(listDepth + 1);
    b.paragraph();
    return;
  }
  if (HEADINGS.has(name)) {
    b.paragraph();
    recurse(listDepth);
    b.paragraph();
    return;
  }
  if (name === 'td' || name === 'th') {
    recurse(listDepth);
    b.inline(' ');
    return;
  }
  if (name === 'p' || name === 'blockquote' || name === 'pre' || name === 'table') {
    b.paragraph();
    recurse(listDepth);
    b.paragraph();
    return;
  }
  if (BLOCKS.has(name)) {
    b.newline();
    recurse(listDepth);
    b.newline();
    return;
  }
  recurse(listDepth);
}

/** True when the input looks like entity-escaped HTML with no real tags. */
function isEscapedHtml(input: string): boolean {
  return !/<[a-z!/]/i.test(input) && /&lt;\/?[a-z]/i.test(input);
}

function unescapeIfNeeded(html: string): string {
  return isEscapedHtml(html) ? load(`<textarea>${html}</textarea>`)('textarea').text() : html;
}

function render(root: DomNode | undefined, b: TextBuilder): string {
  if (!root) return '';
  walk(root, b, 0);
  return b
    .toString()
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
}

export function htmlToText(html: string): string {
  if (!html.trim()) return '';
  const $ = load(unescapeIfNeeded(html));
  return render($.root().get(0) as unknown as DomNode | undefined, new TextBuilder());
}

/** Whether `html` (after unescaping) contains markup; tagless input is plain text (5a13fed). */
export function hasMarkup(html: string): boolean {
  return /<[a-z!/][^>]*>/i.test(unescapeIfNeeded(html));
}

/** The rendering of one parse tree with, per rendered line, whether it is restricted. */
function analyse(root: DomNode | undefined): { text: string; lines: Segment[]; restricted: boolean[] } {
  const b = new TextBuilder();
  const text = render(root, b);
  const rendered = lines(text);
  // One flag per rendered non-empty line, in order; if that ever fails to line up, every line is
  // restricted (never a wrong stated value).
  const restricted =
    rendered.length === b.restrictedLines.length ? b.restrictedLines : rendered.map(() => true);
  return { text, lines: rendered, restricted };
}

/** A style sheet, linked resource or script anywhere: no line of the description is plain text. */
const ACTIVE_CONTENT = /<\s*(?:style|link|script)\b/i;

/**
 * The CANONICAL rendering sponsorship statements are read from (DECISION_LOG a720377 (1),
 * 5a13fed, 7f01fe5): the rendering of the lenient (htmlparser2) tree, plus the START OFFSETS of
 * its lines that may not yield a stated value. A line may yield one only if:
 *
 *  - every element overlapping it — ancestors, descendants, and any empty or line-breaking element
 *    inside it or at its boundary — is an allowlisted plain-flow tag with no attribute other than
 *    `lang` / `dir` (no CSS is interpreted: `style`, `class`, `id`, `hidden`, `aria-*`, `role` …
 *    are enough);
 *  - the description has no `<style>`, `<link>` or `<script>` anywhere;
 *  - the HTML5 (parse5) tree renders the same line text and agrees it is unrestricted — so
 *    unclosed formatting elements, and stray table fragments the HTML5 parser flattens, never
 *    yield a stated value.
 *
 * Layout is matched by position, never by text.
 */
export function htmlToTextWithLayout(html: string): { text: string; layoutLineStarts: number[] } {
  if (!html.trim()) return { text: '', layoutLineStarts: [] };
  const source = unescapeIfNeeded(html);
  const lenient = analyse(
    load(source, { xml: { xmlMode: false, decodeEntities: true } })
      .root()
      .get(0) as unknown as DomNode,
  );
  if (ACTIVE_CONTENT.test(source))
    return { text: lenient.text, layoutLineStarts: lenient.lines.map((l) => l.start) };
  const strict = analyse(load(source).root().get(0) as unknown as DomNode);
  return { text: lenient.text, layoutLineStarts: agreedLayout(lenient, strict) };
}

/**
 * The start offsets (in the lenient rendering) of the lines the two parse trees do not agree are
 * unrestricted: restricted in either tree, or with no line of the same text in the HTML5 tree
 * (matched in order). Exported for tests.
 */
export function agreedLayout(
  lenient: { lines: Segment[]; restricted: boolean[] },
  strict: { lines: Segment[]; restricted: boolean[] },
): number[] {
  const layout: number[] = [];
  let next = 0;
  lenient.lines.forEach((line, i) => {
    let k = next;
    while (k < strict.lines.length && strict.lines[k]!.text !== line.text) k++;
    if (k === strict.lines.length) {
      // The HTML5 tree renders no such line: the parsers disagree.
      layout.push(line.start);
      return;
    }
    next = k + 1;
    if (lenient.restricted[i] || strict.restricted[k]) layout.push(line.start);
  });
  return layout;
}
