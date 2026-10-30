import type { Actor } from '@aptamind/contracts';
import { strictNameKey } from '../companies/normalize';
import type { CompanyObservationPayload } from '../contracts/observations';
import type { MarketDomain } from '../market-domain';
import { sourceTimeOf } from '../observations/schemas';
import type { CompanySummary } from '../resolution/company-resolver';
import { atsBoardIdentity, raiseBoardOwnerReview, registerAtsBoard } from './board-registration';
import { ATS_BOARD_DIRECTORY_PARSER_V1, type BoardRow } from './providers/ats-board-directory';

/** Resolver version stamped on board-file observations (attach-only, exact matches). */
export const ATS_BOARD_RESOLVER_VERSION = 'ats-board-attach@1';

/** How often a board from a file is refreshed (same default as careers discovery). */
const BOARD_REFRESH_MINUTES = 360;

export type BoardRowOutcome = 'registered' | 'unchanged' | 'review' | 'other_owner';

export interface BoardRowResult {
  outcome: BoardRowOutcome;
  observationId: string;
  companyId?: string;
  sourceId?: string;
  reviewItemId?: string;
}

type Decision =
  | { kind: 'match'; company: CompanySummary; method: 'domain' | 'strict_name' }
  | { kind: 'unmatched'; reason: string; candidates: CompanySummary[] };

/**
 * Attach-only company decision (M8.2): an exact domain match wins; without a domain, a unique
 * exact name match. Never creates a company.
 */
async function decide(market: MarketDomain, row: BoardRow): Promise<Decision> {
  const byName = row.company ? await market.companies.byStrictName(strictNameKey(row.company)) : [];
  if (row.domain) {
    const company = await market.companies.byIdentityKey(`domain:${row.domain}`);
    return company
      ? { kind: 'match', company, method: 'domain' }
      : { kind: 'unmatched', reason: 'No company has this domain', candidates: byName };
  }
  if (byName.length === 1) return { kind: 'match', company: byName[0]!, method: 'strict_name' };
  return {
    kind: 'unmatched',
    reason: byName.length ? 'Several companies have this exact name' : 'No company has this exact name',
    candidates: byName,
  };
}

/**
 * One row of a known-board file (M8.2). The row is recorded as a company observation of the file
 * (with snapshot provenance and the board), resolved attach-only, then:
 *  - no match or several → a `company_resolution` review; nothing is registered;
 *  - the board already belongs to another company (keys compare case-insensitively) → a review;
 *    the observation stays unresolved and no company record changes;
 *  - otherwise the board is registered as the company's job source (idempotent on its key).
 * A row whose review was later merged registers on the next import of the file.
 */
export async function processBoardRow(
  market: MarketDomain,
  input: { sourceId: string; snapshotId: string; artifactId: string; row: BoardRow; runId: string },
  actor: Actor,
): Promise<BoardRowResult> {
  const { row } = input;
  const decision = await decide(market, row);
  const payload: CompanyObservationPayload = {
    name:
      row.company ??
      (decision.kind === 'match' ? decision.company.displayName : null) ??
      row.domain ??
      row.key,
    domain: row.domain,
    aliases: [],
    externalIds: [],
    locations: [],
    industries: [],
    ats: { provider: row.provider, boardToken: row.boardToken, region: row.region, apiBase: row.apiBase },
  };
  const { observation, created } = await market.observations.recordCompanyObservation({
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    artifactId: input.artifactId,
    locator: row.locator,
    externalId: `board:${row.key}`,
    payload,
    parser: ATS_BOARD_DIRECTORY_PARSER_V1,
    runId: input.runId,
  });
  const state = observation.resolution.state;
  if (state === 'review' || state === 'rejected')
    return {
      outcome: 'review',
      observationId: observation._id,
      reviewItemId: observation.resolution.reviewItemId,
    };

  const resolvedId = state === 'resolved' ? observation.resolution.entityId : undefined;
  if (!resolvedId && decision.kind === 'unmatched') {
    const { item } = await market.reviews.raise({
      type: 'company_resolution',
      severity: 'medium',
      dedupeKey: `company_resolution:ats_board:${observation._id}`,
      entity: { kind: 'observation', id: observation._id },
      subject: `Attach ${row.provider} board ${row.boardToken} to which company?`,
      reason: `${decision.reason}. A board file never creates companies: merge into the right company, or reject. The board is registered when the file is imported again.`,
      evidence: [
        {
          sourceId: observation.sourceId,
          observationId: observation._id,
          snapshotId: observation.snapshotId,
          artifactId: observation.artifactId,
          locator: observation.locator,
          observedAt: sourceTimeOf(observation),
        },
      ],
      candidates: decision.candidates.slice(0, 10).map((c) => ({
        kind: 'company' as const,
        id: c.id,
        label: c.displayName,
      })),
      observationIds: [observation._id],
      context: {
        attachOnly: true,
        board: { provider: row.provider, boardToken: row.boardToken, key: row.key },
        candidate: { name: row.company, domain: row.domain },
      },
      allowedActions: ['merge', 'reject', 'dismiss'],
    });
    await market.observations.setCompanyResolution([observation._id], {
      state: 'review',
      reviewItemId: item._id,
      resolverVersion: ATS_BOARD_RESOLVER_VERSION,
    });
    return { outcome: 'review', observationId: observation._id, reviewItemId: item._id };
  }
  const match = decision.kind === 'match' ? decision : undefined;
  const company = await market.companies.resolveActive(resolvedId ?? match!.company.id);

  // The owner check comes before any resolution or reconcile: the row's ATS data must not reach a
  // company whose board belongs to someone else.
  const existing = await market.sources.getByKeyIgnoringCase(row.key);
  if (existing && existing.companyId !== company._id) {
    const reviewItemId = await raiseBoardOwnerReview(
      market.reviews,
      existing,
      company,
      'A board file names a job board that is already a source of a different company (possible duplicate company or wrong row). Nothing was changed.',
    );
    return {
      outcome: 'other_owner',
      observationId: observation._id,
      companyId: company._id,
      sourceId: existing._id,
      reviewItemId,
    };
  }

  if (resolvedId) {
    if (created) await market.companyReconciler.reconcile(company._id);
  } else {
    await market.observations.setCompanyResolution([observation._id], {
      state: 'resolved',
      entityId: match!.company.id,
      method: match!.method,
      confidence: 'high',
      resolverVersion: ATS_BOARD_RESOLVER_VERSION,
    });
    await market.companyReconciler.reconcile(match!.company.id);
  }
  if (existing)
    return {
      outcome: 'unchanged',
      observationId: observation._id,
      companyId: company._id,
      sourceId: existing._id,
    };
  const registered = await registerAtsBoard(
    market.sources,
    {
      company,
      provider: row.provider,
      boardToken: row.boardToken,
      // The stored token keeps its first-seen case for fetching; the key is lowercased.
      identity: { ...atsBoardIdentity(row.provider, row.boardToken, row.apiBase), key: row.key },
      refreshIntervalMinutes: BOARD_REFRESH_MINUTES,
      enableSchedule: true,
    },
    actor,
  );
  return {
    // A concurrent registration of the same board (another run) counts as already there.
    outcome: registered.created ? 'registered' : 'unchanged',
    observationId: observation._id,
    companyId: company._id,
    sourceId: registered.source._id,
  };
}
