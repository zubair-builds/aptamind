import type { CompanyDoc } from '../companies/company.schema';
import type { JobInterpretationInput } from '../contracts/employment';
import { hasMarkup, htmlToText, htmlToTextWithLayout } from '../enrichment/html';
import type { JobObservationDoc } from '../observations/schemas';

/** The description text of a job observation (plain text, else rendered HTML; ≤ 200k chars). */
export function descriptionTextOf(o: Pick<JobObservationDoc, 'payload'>): string {
  return fullDescriptionTextOf(o).slice(0, 200_000);
}

/** The description text before the 200k cap. */
function fullDescriptionTextOf(o: Pick<JobObservationDoc, 'payload'>): string {
  return (
    o.payload.descriptionText?.trim() ||
    (o.payload.descriptionHtml ? htmlToText(o.payload.descriptionHtml) : '')
  );
}

/** Statement text capped at 200k characters WITHOUT a partial last line (7f01fe5 L2). */
export const STATEMENT_TEXT_LIMIT = 200_000;
function wholeLines(text: string): string {
  // `text` is never pre-cut: a text of exactly the limit keeps its complete last line (bc013e8 L3).
  if (text.length <= STATEMENT_TEXT_LIMIT) return text;
  const cut = text.slice(0, STATEMENT_TEXT_LIMIT);
  // The line the cap runs into is dropped (it may end mid-value: "…: Not available" → "…: No").
  if (text[STATEMENT_TEXT_LIMIT] === '\n' || cut.endsWith('\n')) return cut;
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak < 0 ? '' : cut.slice(0, lastBreak);
}

/**
 * The canonical rendering sponsorship statements are read from (DECISION_LOG a720377 (1),
 * 5a13fed): the enrichment layout rendering of `descriptionHtml` whenever it contains markup —
 * whatever `descriptionText` a connector stored (its renderer joins table cells without a
 * separator) — else `descriptionText` itself. Stored texts are not changed (no hash churn).
 */
export function statementSourceOf(
  o: Pick<JobObservationDoc, 'payload'>,
): NonNullable<JobInterpretationInput['statementSource']> {
  const html = o.payload.descriptionHtml;
  // Only real markup is HTML: a tagless "descriptionHtml" (aggregator / JSON-LD plain text) is
  // read as text, with its newlines (5a13fed).
  if (html?.trim() && hasMarkup(html)) {
    const { text, layoutLineStarts } = htmlToTextWithLayout(html);
    const cut = wholeLines(text);
    return {
      rendering: 'html_layout',
      text: cut,
      layoutLineStarts: layoutLineStarts.filter((start) => start < cut.length),
    };
  }
  return { rendering: 'description_text', text: wholeLines(fullDescriptionTextOf(o)), layoutLineStarts: [] };
}

/**
 * The interpretation input of one source copy: its observation's provider fields plus the
 * company context (current licence countries, hiring-history countries, lapsed licences, HQ). The only
 * constructor of that input — reconciliation and the `market.interpret_job` inspection both use
 * it (M6.4), so an inspection can never disagree with the canonical facts.
 */
export function interpretationInput(
  o: JobObservationDoc,
  company: CompanyDoc | null,
): JobInterpretationInput {
  const previously =
    company?.employment.sponsorship.licences
      .filter((l) => l.status === 'no_longer_listed')
      .map((l) => l.country) ?? [];
  return {
    title: o.payload.title,
    descriptionText: descriptionTextOf(o),
    statementSource: statementSourceOf(o),
    locationTexts: o.payload.locations.map((l) => l.text),
    provider: {
      workplaceType: o.payload.workplaceType ?? null,
      employmentTypeText: o.payload.employmentTypeText ?? null,
      department: o.payload.department ?? null,
      compensation: o.payload.compensation ?? null,
    },
    company: company
      ? {
          sponsorLicenceCountries: company.employment.sponsorship.licenceCountries,
          // Hiring history from history registers (M11.5, e.g. US H-1B approvals). A lapsed licence
          // is past capability, not hiring history (M11.1).
          historicalSponsorshipCountries: company.employment.sponsorship.historyCountries ?? [],
          previousLicenceCountries: [...new Set(previously)],
          hqCountry: company.geography.headquarters.value?.country ?? null,
        }
      : null,
  };
}
