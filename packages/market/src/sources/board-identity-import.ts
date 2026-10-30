import type { ClientSession } from 'mongodb';
import {
  type Actor,
  deterministicId,
  InvalidStateError,
  NotFoundError,
  SYSTEM_ACTOR,
} from '@aptamind/contracts';
import { isDuplicateKeyError, withTransaction } from '@aptamind/db';
import type { CompanyDoc } from '../companies/company.schema';
import { emptyCompany } from '../companies/company.service';
import { atsExternalId } from '../companies/external-ids';
import { strictNameKey } from '../companies/normalize';
import type { CompanyObservationPayload } from '../contracts/observations';
import type { MarketDomain } from '../market-domain';
import { ContradictingIdError } from '../observations/observation.service';
import { type CompanyObservationDoc, sourceTimeOf } from '../observations/schemas';
import type { CompanySummary } from '../resolution/company-resolver';
import type { BoardLiveness } from './board-liveness';
import { atsBoardIdentity, raiseBoardOwnerReview, registerAtsBoard } from './board-registration';
import { ATS_BOARD_DIRECTORY_PARSER, type BoardRow } from './providers/ats-board-directory';
import type { SourceDoc } from './source.schema';
import { boardOfSource } from './source-standing';

/** Resolver version stamped on board-file observations (OPS-1b: a live board anchors a company). */
export const ATS_BOARD_IDENTITY_RESOLVER_VERSION = 'ats-board-identity@1';

/** How often a board from a file is refreshed (same default as careers discovery). */
const BOARD_REFRESH_MINUTES = 360;
/** A lost creation race re-decides; more than this many losses in a row is a real conflict. */
const MAX_ATTEMPTS = 3;

export type BoardRowFailure = 'board_not_live' | 'board_unreachable' | 'no_identity';

export type BoardIdentityResult =
  | {
      outcome: 'registered' | 'unchanged' | 'review' | 'other_owner';
      observationId: string;
      companyId?: string;
      sourceId?: string;
      reviewItemId?: string;
      /** The company was created from this row's live board (branch f). */
      companyCreated?: boolean;
    }
  | { outcome: 'failed'; code: BoardRowFailure; line: number; reason: string };

type Decision =
  | { kind: 'owner'; company: CompanyDoc }
  | { kind: 'match'; company: CompanySummary; method: 'domain' | 'ats_id' | 'strict_name' }
  | { kind: 'review'; reason: string; candidates: CompanySummary[] }
  | { kind: 'none' };

/**
 * Branches b–e of the OPS-1b order (a, the board's own source, is checked first by the caller):
 * domain, then the board's `ats` id, then a unique exact name when the row has no domain. A name
 * match that cannot attach (several, or a domain that matches nobody) is a review, as in M8.2.
 */
async function decide(market: MarketDomain, row: BoardRow): Promise<Decision> {
  const ats = atsExternalId(row.key);
  const [byDomain, byAts, byName] = await Promise.all([
    row.domain ? market.companies.byIdentityKey(`domain:${row.domain}`) : null,
    market.companies.byIdentityKey(`ext:${ats.namespace}:${ats.id}`),
    row.company ? market.companies.byStrictName(strictNameKey(row.company)) : [],
  ]);
  if (byDomain && byAts && byDomain.id !== byAts.id)
    return {
      kind: 'review',
      reason: 'The domain names one company and the board is the identity of another',
      candidates: [byDomain, byAts],
    };
  if (byDomain) return { kind: 'match', company: byDomain, method: 'domain' };
  if (byAts) return { kind: 'match', company: byAts, method: 'ats_id' };
  if (!row.domain && byName.length === 1)
    return { kind: 'match', company: byName[0]!, method: 'strict_name' };
  if (byName.length)
    return {
      kind: 'review',
      reason: row.domain
        ? 'No company has this domain, but a company has this exact name'
        : 'Several companies have this exact name',
      candidates: byName,
    };
  return { kind: 'none' };
}

type Live = Extract<BoardLiveness, { state: 'live' }>;
type RowInput = { sourceId: string; snapshotId: string; artifactId: string; row: BoardRow; runId: string };

/**
 * One row of a known-board file (OPS-1b). Resolution order:
 *  a. the board is already a source → its company (unchanged), or an owner review when the row's
 *     domain names another company. A source with no owner is attached to the row's company;
 *  b–e. domain, `ats` id, unique exact name without a domain → register the board for it; a name
 *     match that cannot attach → a `company_resolution` review;
 *  f. no match → one liveness fetch. Live → the board source is claimed first for the company id
 *     hash(board key), then that company is created (`ats` id, provenance to the file row and the
 *     board snapshot). Not live or unreachable → a row failure; nothing is recorded or created.
 * A company is created only by the run whose claim holds the board, so no company exists without
 * its board and no board gets two companies. Every owner change is conditional: a lost race
 * decides again. A row with no name and no domain whose board has no owner fails with
 * `no_identity`. A row whose review was later merged registers on the next import of the file.
 */
export async function processBoardRowV2(
  market: MarketDomain,
  input: RowInput,
  probe: (row: BoardRow) => Promise<BoardLiveness>,
  actor: Actor,
): Promise<BoardIdentityResult> {
  const { row } = input;
  const anchoredId = deterministicId('cmp', 'ats_board', row.key);
  let liveness: Live | null = null;
  /** One liveness fetch per row run; null when live, else the row failure. */
  const ensureLive = async (): Promise<BoardIdentityResult | null> => {
    if (liveness) return null;
    const probed = await probe(row);
    if (probed.state === 'live') {
      liveness = probed;
      return null;
    }
    return {
      outcome: 'failed',
      code: probed.state === 'not_live' ? 'board_not_live' : 'board_unreachable',
      line: row.line,
      reason: probed.reason,
    };
  };
  // Fixed by the first decision, so a retry after a lost race records the same observation.
  let name: string | null = null;
  for (let attempt = 1; ; attempt++) {
    if (attempt > MAX_ATTEMPTS) throw new Error(`Board ${row.key}: kept losing races, try the row again`);
    const existing = await market.sources.getByKeyIgnoringCase(row.key);
    const owner = existing?.companyId ? await activeOrNull(market, existing.companyId) : null;
    // The source was claimed for this board's company, which does not exist yet (a crash between
    // the claim and the creation): this row finishes the creation.
    const claimedForAnchor = existing?.companyId === anchoredId && !owner;
    if (existing?.companyId && !owner && !claimedForAnchor)
      throw new Error(
        `Board ${row.key}: its source names company ${existing.companyId}, which does not exist`,
      );
    if (!owner && !claimedForAnchor && !row.company && !row.domain)
      return {
        outcome: 'failed',
        code: 'no_identity',
        line: row.line,
        reason: 'The row has no company name and no domain, and the board has no company yet',
      };

    const decision: Decision = owner
      ? { kind: 'owner', company: owner }
      : claimedForAnchor
        ? { kind: 'none' }
        : await decide(market, row);
    name ??= rowName(row, decision);
    if (decision.kind === 'none') {
      const failed = await ensureLive();
      if (failed) return failed;
    }
    const { observation, created: recorded } = await recordRow(market, input, name);
    const state = observation.resolution.state;
    if (state === 'review' || state === 'rejected')
      return {
        outcome: 'review',
        observationId: observation._id,
        reviewItemId: observation.resolution.reviewItemId,
      };

    // A row linked earlier (a re-import, or a review merged since) keeps its company.
    let company: CompanyDoc | null =
      state === 'resolved' && observation.resolution.entityId
        ? await market.companies.resolveActive(observation.resolution.entityId)
        : null;
    let method: string = 'previous_link';
    let companyCreated = false;
    let boardClaimed = false;
    let boardId = existing?._id;
    if (!company) {
      if (decision.kind === 'review')
        return raiseRowReview(market, row, observation, decision.reason, decision.candidates);
      if (decision.kind === 'owner') {
        const other = row.domain ? await market.companies.byIdentityKey(`domain:${row.domain}`) : null;
        if (other && other.id !== decision.company._id)
          return ownerConflict(
            market,
            observation,
            existing!,
            await market.companies.resolveActive(other.id),
          );
        company = decision.company;
        method = 'ats_board_source';
      } else if (decision.kind === 'match') {
        company = await market.companies.resolveActive(decision.company.id);
        method = decision.method;
      } else {
        // f: claim the board for hash(board key) first; only the holder of the claim creates.
        const live = liveness!;
        const claim = await claimBoard(market, input, name, anchoredId, existing, actor);
        if (!claim) continue;
        await recordBoardSnapshot(market, claim, live, input.runId);
        const doc = await createAnchoredCompany(market, input, name, anchoredId, observation._id, live);
        if (!doc) {
          // Another company took the name or domain meanwhile: give the board back (unscheduled
          // until a later row or a reviewer attaches it), decide again.
          await market.sources.setOwnerIf(claim._id, anchoredId, null, actor, 'company identity taken');
          continue;
        }
        company = await market.companies.resolveActive(doc._id);
        method = 'ats_board_live';
        companyCreated = true;
        boardClaimed = true;
        boardId = claim._id;
        // The owner exists now (also when this run heals an earlier crash): fetch on schedule.
        await scheduleBoard(market, claim._id, actor);
      }
    }
    // The owner check comes before any link: the row's evidence must not reach a company whose
    // board belongs to someone else. A source with no owner is attached to the row's company.
    if (existing && !companyCreated && existing.companyId !== company._id) {
      if (existing.companyId) return ownerConflict(market, observation, existing, company);
      if (company._id === anchoredId) {
        const failed = await ensureLive();
        if (failed) return failed;
      }
      if (!(await market.sources.setOwnerIf(existing._id, null, company._id, actor, 'board file row')))
        continue;
      boardClaimed = true;
      await scheduleBoard(market, existing._id, actor);
    }

    const linkNow =
      observation.resolution.state !== 'resolved' || observation.resolution.entityId !== company._id;
    if (linkNow) {
      try {
        await market.observations.setCompanyResolution(
          [observation._id],
          {
            state: 'resolved',
            entityId: company._id,
            method,
            confidence: 'high',
            resolverVersion: ATS_BOARD_IDENTITY_RESOLVER_VERSION,
          },
          // Claims the board's `ats` id for the company in the link transaction.
          { claimKeys: true },
        );
      } catch (err) {
        if (!(err instanceof ContradictingIdError) && !isDuplicateKeyError(err)) throw err;
        // Another company took the board's `ats` id meanwhile: decide again, then ask a reviewer.
        if (attempt < MAX_ATTEMPTS) continue;
        const ats = atsExternalId(row.key);
        const holder = await market.companies.byIdentityKey(`ext:${ats.namespace}:${ats.id}`);
        return raiseRowReview(
          market,
          row,
          observation,
          'The board is the identity of another company than the one this row matches',
          [
            { id: company._id, displayName: displayNameOf(company) },
            ...(holder ? [{ id: holder.id, displayName: holder.displayName }] : []),
          ],
        );
      }
    }
    if (linkNow || recorded) await market.companyReconciler.reconcile(company._id);
    if (boardId && (boardClaimed || existing?.companyId === company._id)) {
      // Heals a replay after a crash between owning the board and scheduling it. An existing
      // schedule is kept; a re-imported board with a cleared schedule gets one again (disable
      // the source to stop its refreshes).
      await scheduleBoard(market, boardId, actor);
      return {
        outcome: boardClaimed ? 'registered' : 'unchanged',
        observationId: observation._id,
        companyId: company._id,
        sourceId: boardId,
        ...(companyCreated ? { companyCreated: true } : {}),
      };
    }

    // b–e: a board with no source yet. The board-anchored company (found by its `ats` id after an
    // older run) gets its board only with a fresh liveness fetch, so its snapshot is never missing.
    if (company._id === anchoredId) {
      const failed = await ensureLive();
      if (failed) return failed;
    }
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
    if (!registered.created && registered.source.companyId !== company._id) {
      // Discovery registered the board meanwhile: decide again (branch a, or an owner review).
      continue;
    }
    if (registered.created && liveness) {
      await recordBoardSnapshot(market, registered.source, liveness, input.runId);
      if (company._id === anchoredId)
        await recordCreation(market, input, anchoredId, observation._id, liveness);
    }
    return {
      outcome: registered.created ? 'registered' : 'unchanged',
      observationId: observation._id,
      companyId: company._id,
      sourceId: registered.source._id,
    };
  }
}

/** The active company `id` resolves to, or null when no such company exists. */
async function activeOrNull(market: MarketDomain, id: string): Promise<CompanyDoc | null> {
  try {
    return await market.companies.resolveActive(id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/**
 * Claim the board source for the company id hash(board key) before that company exists: register
 * it, take it when it has no owner, or keep the claim an earlier run of this row made. Null when
 * another company holds the board (the caller decides again).
 */
async function claimBoard(
  market: MarketDomain,
  input: RowInput,
  name: string,
  anchoredId: string,
  existing: SourceDoc | null,
  actor: Actor,
): Promise<SourceDoc | null> {
  const { row } = input;
  if (existing) {
    if (existing.companyId === anchoredId) return existing;
    if (existing.companyId) return null;
    return (await market.sources.setOwnerIf(existing._id, null, anchoredId, actor, 'board file row'))
      ? existing
      : null;
  }
  // The planned company: registerAtsBoard reads only its id and name.
  const planned = emptyCompany(anchoredId, name, [], market.ctx.clock.now());
  const registered = await registerAtsBoard(
    market.sources,
    {
      company: planned,
      provider: row.provider,
      boardToken: row.boardToken,
      identity: { ...atsBoardIdentity(row.provider, row.boardToken, row.apiBase), key: row.key },
      refreshIntervalMinutes: BOARD_REFRESH_MINUTES,
      // No schedule until the company exists: a fetch needs a real owner.
      enableSchedule: false,
    },
    actor,
  );
  if (registered.created || registered.source.companyId === anchoredId) return registered.source;
  if (registered.source.companyId) return null;
  return (await market.sources.setOwnerIf(registered.source._id, null, anchoredId, actor, 'board file row'))
    ? registered.source
    : null;
}

/**
 * Give a board source its refresh schedule once it has a real owner. A schedule set earlier (by
 * an operator or discovery) is kept.
 */
async function scheduleBoard(market: MarketDomain, sourceId: string, actor: Actor): Promise<void> {
  const source = await market.sources.get(sourceId);
  if (source.schedule?.cron || source.schedule?.intervalMinutes) return;
  await market.sources.update(
    sourceId,
    { schedule: { intervalMinutes: BOARD_REFRESH_MINUTES, timezone: 'UTC' } },
    actor,
  );
}

/** The liveness response is a snapshot of the board (content-addressed: a replay records it once). */
async function recordBoardSnapshot(market: MarketDomain, source: SourceDoc, live: Live, runId: string) {
  await market.observations.recordSnapshot({
    sourceId: source._id,
    artifact: live.artifact,
    url: live.url,
    httpStatus: live.httpStatus,
    contentType: live.contentType,
    runId,
    via: 'http',
    board: boardOfSource(source),
  });
}

/**
 * Create the board-anchored company and its creation event in one transaction, so the event (with
 * the board snapshot) exists exactly when the company does. Null when another company holds the
 * name or domain key.
 */
async function createAnchoredCompany(
  market: MarketDomain,
  input: RowInput,
  name: string,
  anchoredId: string,
  observationId: string,
  live: Live,
): Promise<CompanyDoc | null> {
  try {
    return await withTransaction(market.ctx.db.client, async (session) => {
      const doc = await market.companies.createFromCandidate(
        { name, domain: input.row.domain, externalIds: [atsExternalId(input.row.key)] },
        { id: anchoredId, session },
      );
      await recordCreation(market, input, anchoredId, observationId, live, session);
      return doc;
    });
  } catch (err) {
    if (!(err instanceof InvalidStateError)) throw err;
    // A concurrent run of this row created it first; anything else holds the name or domain.
    return activeOrNull(market, anchoredId);
  }
}

/** One creation event per board: the first writer wins, so two concurrent runs record it once. */
async function recordCreation(
  market: MarketDomain,
  input: RowInput,
  companyId: string,
  observationId: string,
  live: Live,
  session?: ClientSession,
) {
  await market.audit.record(
    {
      actor: SYSTEM_ACTOR,
      action: 'company.created_from_ats_board',
      entity: { kind: 'company', id: companyId },
      runId: input.runId,
      onceKey: `company.created_from_ats_board:${input.row.key}`,
      details: {
        board: input.row.key,
        observationId,
        importSourceId: input.sourceId,
        importSnapshotId: input.snapshotId,
        locator: input.row.locator,
        boardArtifactId: live.artifact.artifactId,
        jobsAtCreation: live.jobs,
      },
    },
    session ? { session } : {},
  );
}

const displayNameOf = (c: CompanyDoc): string => c.identity.displayName.value ?? c.identity.normalizedName;

/** A row without a name takes the name of the company it attaches to (as in M8.2). */
function rowName(row: BoardRow, decision: Decision): string {
  const known =
    decision.kind === 'owner'
      ? displayNameOf(decision.company)
      : decision.kind === 'match'
        ? decision.company.displayName
        : null;
  return row.company ?? known ?? row.domain ?? row.key;
}

/** The row as a company observation of the file; it always carries the board's `ats` id. */
async function recordRow(
  market: MarketDomain,
  input: RowInput,
  name: string,
): Promise<{ observation: CompanyObservationDoc; created: boolean }> {
  const { row } = input;
  const payload: CompanyObservationPayload = {
    name,
    domain: row.domain,
    aliases: [],
    externalIds: [atsExternalId(row.key)],
    locations: [],
    industries: [],
    ats: { provider: row.provider, boardToken: row.boardToken, region: row.region, apiBase: row.apiBase },
  };
  return market.observations.recordCompanyObservation({
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    artifactId: input.artifactId,
    locator: row.locator,
    externalId: `board:${row.key}`,
    payload,
    parser: ATS_BOARD_DIRECTORY_PARSER,
    runId: input.runId,
  });
}

async function ownerConflict(
  market: MarketDomain,
  observation: CompanyObservationDoc,
  existing: SourceDoc,
  company: CompanyDoc,
): Promise<BoardIdentityResult> {
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

async function raiseRowReview(
  market: MarketDomain,
  row: BoardRow,
  observation: CompanyObservationDoc,
  reason: string,
  candidates: Array<Pick<CompanySummary, 'id' | 'displayName'>>,
): Promise<BoardIdentityResult> {
  const { item } = await market.reviews.raise({
    type: 'company_resolution',
    severity: 'medium',
    dedupeKey: `company_resolution:ats_board:${observation._id}`,
    entity: { kind: 'observation', id: observation._id },
    subject: `Attach ${row.provider} board ${row.boardToken} to which company?`,
    reason: `${reason}. Merge into the right company, or reject. The board is registered when the file is imported again.`,
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
    candidates: candidates
      .slice(0, 10)
      .map((c) => ({ kind: 'company' as const, id: c.id, label: c.displayName })),
    observationIds: [observation._id],
    context: {
      board: { provider: row.provider, boardToken: row.boardToken, key: row.key },
      candidate: { name: row.company, domain: row.domain },
    },
    allowedActions: ['merge', 'reject', 'dismiss'],
  });
  await market.observations.setCompanyResolution([observation._id], {
    state: 'review',
    reviewItemId: item._id,
    resolverVersion: ATS_BOARD_IDENTITY_RESOLVER_VERSION,
  });
  return { outcome: 'review', observationId: observation._id, reviewItemId: item._id };
}
