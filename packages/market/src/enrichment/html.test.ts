import { describe, expect, it } from 'vitest';
import { agreedLayout, htmlToText, htmlToTextWithLayout } from './html';

describe('htmlToText', () => {
  it('keeps headings, paragraphs and list items as lines', () => {
    const html = `
      <h2>About the role</h2>
      <p>We build <strong>payments</strong> infrastructure.</p>
      <h3>Requirements</h3>
      <ul><li>5+ years of <em>Go</em></li><li>Kubernetes</li></ul>
      <p>Apply today!</p>`;
    expect(htmlToText(html)).toBe(
      'About the role\n\nWe build payments infrastructure.\n\nRequirements\n\n- 5+ years of Go\n- Kubernetes\n\nApply today!',
    );
  });

  it('decodes entities and strips scripts, styles and comments', () => {
    const html =
      '<style>.x{}</style><script>alert(1)</script><p>R&amp;D &mdash; caf&eacute; &pound;50k&nbsp;p.a.<!-- hidden --></p>';
    expect(htmlToText(html)).toBe('R&D — café £50k p.a.');
  });

  it('handles line breaks, nested lists and divs', () => {
    const html = '<div>Line one<br>Line two</div><ul><li>Parent<ul><li>Child</li></ul></li></ul>';
    expect(htmlToText(html)).toBe('Line one\nLine two\n- Parent\n  - Child');
  });

  it('unescapes entity-encoded HTML payloads (Greenhouse style)', () => {
    const escaped = '&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;';
    expect(htmlToText(escaped)).toBe('Hello & welcome\n\n- One');
  });

  it('collapses whitespace and returns empty text for empty input', () => {
    expect(htmlToText('<p>  lots   of\n\n  space </p>')).toBe('lots of space');
    expect(htmlToText('   ')).toBe('');
    expect(htmlToText('plain text only')).toBe('plain text only');
  });

  it('renders table cells separated by spaces', () => {
    expect(htmlToText('<table><tr><td>Salary</td><td>£50k</td></tr></table>')).toBe('Salary £50k');
  });

  /** The rendered lines outside the statement context, by text (for readable assertions). */
  const layoutOf = (html: string) => {
    const { text, layoutLineStarts } = htmlToTextWithLayout(html);
    return text.split('\n').filter((l, i, all) => {
      const start = all.slice(0, i).reduce((n, x) => n + x.length + 1, 0) + (l.length - l.trimStart().length);
      return l.trim() && layoutLineStarts.includes(start);
    });
  };

  it('reports the start offsets of layout lines without changing the rendering (3dfe3c5, 5a13fed)', () => {
    const html =
      '<p>Intro</p><table><tr><th>Benefit</th><th>UK</th></tr><tr><td>Visa sponsorship:</td><td></td><td>No</td></tr></table><p>Salary: £50k</p>';
    const layout = htmlToTextWithLayout(html);
    expect(layout.text).toBe(htmlToText(html));
    expect(layout.text).toBe('Intro\n\nBenefit UK\nVisa sponsorship: No\n\nSalary: £50k');
    expect(layout.layoutLineStarts).toEqual([7, 18]);
    expect(layoutOf(html)).toEqual(['Benefit UK', 'Visa sponsorship: No']);
    expect(htmlToTextWithLayout('<p>Visa sponsorship: No</p>').layoutLineStarts).toEqual([]);
  });

  it('matches layout by position: a real <p> line identical to a table line keeps its place (5a13fed L-a)', () => {
    const html = '<p>Visa sponsorship: No</p><table><tr><td>Visa sponsorship: No</td></tr></table>';
    const { text, layoutLineStarts } = htmlToTextWithLayout(html);
    expect(text).toBe('Visa sponsorship: No\n\nVisa sponsorship: No');
    expect(layoutLineStarts).toEqual([22]);
  });

  it('marks lines holding table-element text even without a <table> ancestor (a720377 L1)', () => {
    expect(layoutOf('<tr><td>Visa sponsorship:</td><td>No</td></tr>')).toEqual(['Visa sponsorship: No']);
    expect(layoutOf('<p>Benefits</p><td>Visa sponsorship:</td><td>No</td>')).toEqual([
      'Visa sponsorship: No',
    ]);
    expect(layoutOf('<TABLE><TR><TD>Visa sponsorship:</TD><TD>No</TD></TR></TABLE>')).toEqual([
      'Visa sponsorship: No',
    ]);
    // A CSS grid needs an attribute, and any attribute takes the line out (7f01fe5): no residual.
    expect(layoutOf('<div style="display:table-row"><div>Visa sponsorship: No</div></div>')).toEqual([
      'Visa sponsorship: No',
    ]);
  });

  it.each([
    '<p><s>Visa sponsorship: Yes</s></p>',
    '<p><del>Visa sponsorship: Yes</del></p>',
    '<p><strike>Visa sponsorship: Yes</strike></p>',
    '<p style="text-decoration: line-through">Visa sponsorship: Yes</p>',
    '<ul><li><s>Visa sponsorship: Yes</s></li></ul>',
    '<p>Visa sponsorship: <s>Yes</s></p>',
    '<div hidden><p>Visa sponsorship: Yes</p></div>',
    '<div aria-hidden="true"><p>Visa sponsorship: Yes</p></div>',
    '<p style="display:none">Visa sponsorship: No</p>',
    '<p style="visibility: hidden">Visa sponsorship: No</p>',
    '<div role="row"><span role="cell">Visa sponsorship:</span> <span role="cell">No</span></div>',
    '<p><ins>Visa sponsorship: Yes</ins></p>',
    '<p><mark>Visa sponsorship: Yes</mark></p>',
    '<p><a href="#">Visa sponsorship: Yes</a></p>',
    '<details><summary>Visa sponsorship: Yes</summary></details>',
    '<blockquote>Visa sponsorship: Yes</blockquote>',
  ])('text outside the allowlisted, visible statement context is layout (5a13fed): %s', (html) => {
    expect(layoutOf(html)).toEqual([htmlToTextWithLayout(html).text.trim()]);
  });

  it.each([
    '<p>Visa sponsorship: No</p>',
    '<div><span><strong>Visa sponsorship:</strong> <em>No</em></span></div>',
    '<ul><li><b>Visa sponsorship</b>: <i>Yes</i></li></ul>',
    '<section><article><h3>Visa sponsorship: No</h3></article></section>',
    '<p><u>Visa sponsorship: No</u></p>',
  ])('allowlisted plain-flow text is a statement context: %s', (html) => {
    expect(htmlToTextWithLayout(html).layoutLineStarts).toEqual([]);
  });

  it.each([
    '<p style="font-size:0">Visa sponsorship: Yes</p>',
    '<p style="color:transparent">Visa sponsorship: Yes</p>',
    '<div style="opacity:0"><p>Visa sponsorship: Yes</p></div>',
    '<div style="height:0;overflow:hidden"><p>Visa sponsorship: Yes</p></div>',
    '<p style="position:absolute;left:-9999px">Visa sponsorship: Yes</p>',
    '<p style="clip:rect(0 0 0 0)">Visa sponsorship: Yes</p>',
    '<p style="visibility:collapse">Visa sponsorship: Yes</p>',
    '<p style="display:/**/none">Visa sponsorship: Yes</p>',
    '<p style="display:\\6e one">Visa sponsorship: Yes</p>',
    '<p class="hidden">Visa sponsorship: Yes</p>',
    '<p class="sr-only">Visa sponsorship: Yes</p>',
    '<p class="visually-hidden">Visa sponsorship: Yes</p>',
    '<p class="d-none">Visa sponsorship: Yes</p>',
    '<p style="display:inline">Visa sponsorship: No</p>',
    '<p>Visa sponsorship: No<br style="display:none"></p>',
    '<p>Visa sponsorship: No<span hidden><br></span></p>',
    '<p>Visa sponsorship: <svg><text>x</text></svg>No</p>',
    '<p>Visa sponsorship: No<button>Apply</button></p>',
    '<p>Visa sponsorship: No<object></object></p>',
    '<p>Visa sponsorship: No<iframe></iframe></p>',
  ])(
    'any attribute or non-allowlisted element on a line takes it out, no CSS parsed (7f01fe5): %s',
    (html) => {
      expect(layoutOf(html).length).toBeGreaterThan(0);
      expect(layoutOf(html)).toEqual(
        htmlToTextWithLayout(html)
          .text.split('\n')
          .filter((l) => l.trim()),
      );
    },
  );

  it('an empty restricted element marks the lines at its boundary (7f01fe5)', () => {
    expect(layoutOf('<div>Visa sponsorship: No<p hidden></p>Visa sponsorship: Yes</div>')).toEqual([
      'Visa sponsorship: No',
      'Visa sponsorship: Yes',
    ]);
  });

  it('a <style>, <link> or <script> anywhere: no line is a statement context (7f01fe5)', () => {
    for (const html of [
      '<style>.legacy{display:none}</style><p class="legacy">Visa sponsorship: Yes</p><p>Visa sponsorship: No</p>',
      '<link rel="stylesheet" href="x.css"><p>Visa sponsorship: No</p>',
      '<p>Visa sponsorship: No</p><script>var x = 1</script>',
    ])
      expect(layoutOf(html)).toEqual(
        htmlToTextWithLayout(html)
          .text.split('\n')
          .filter((l) => l.trim()),
      );
  });

  it('both parsers must agree (7f01fe5 H2): unclosed formatting and flattened fragments are layout', () => {
    expect(layoutOf('<p><s>Visa sponsorship: No</p><p>Visa sponsorship: Yes</p>')).toEqual([
      'Visa sponsorship: No',
      'Visa sponsorship: Yes',
    ]);
    expect(
      layoutOf(
        '<p><b style="text-decoration:line-through">Visa sponsorship: Yes</p><p>Visa sponsorship: No</p>',
      ),
    ).toEqual(['Visa sponsorship: Yes', 'Visa sponsorship: No']);
    expect(layoutOf('<p><i hidden>Visa sponsorship: Yes</p><p>Visa sponsorship: No</p>')).toEqual([
      'Visa sponsorship: Yes',
      'Visa sponsorship: No',
    ]);
    expect(layoutOf('<p>Benefits</p><td>Visa sponsorship:</td><td>No</td>')).toEqual([
      'Visa sponsorship: No',
    ]);
  });

  it('plain allowlisted formatting without attributes (lang/dir allowed) stays a statement context', () => {
    for (const html of [
      '<p lang="en" dir="ltr">Visa sponsorship: Yes</p>',
      '<div><strong>Visa sponsorship:</strong> <em>No</em></div>',
      '<p>Visa sponsorship: No</p><p class="footer">Apply now</p>',
    ])
      expect(layoutOf(html).filter((l) => l.startsWith('Visa'))).toEqual([]);
  });

  it('lines whose text the HTML5 tree does not render the same are layout (7f01fe5 H2)', () => {
    const seg = (text: string, start: number) => ({ text, start, end: start + text.length });
    const lenient = {
      lines: [seg('Intro', 0), seg('Visa sponsorship: No', 7), seg('Outro', 29)],
      restricted: [false, false, false],
    };
    // The HTML5 tree renders "Visa sponsorship: Not" (e.g. foster-parented text): no agreement.
    const strict = {
      lines: [seg('Intro', 0), seg('Visa sponsorship: Not', 7), seg('Outro', 30)],
      restricted: [false, false, false],
    };
    expect(agreedLayout(lenient, strict)).toEqual([7]);
    expect(agreedLayout(lenient, { ...lenient, restricted: [false, true, false] })).toEqual([7]);
    expect(agreedLayout(lenient, lenient)).toEqual([]);
  });
});
