import { InvalidStateError } from '@aptamind/contracts';
import { isDuplicateKeyError } from '@aptamind/db';
import { metrics } from '@aptamind/observability';
import type { CompanyObservationPayload } from '../contracts/observations';
import type { MarketContext } from '../context';
import {
  ContradictingIdError,
  type ObservationService,
  type RecordObservationInput,
} from '../observations/observation.service';
import { type CompanyObservationDoc, sourceTimeOf } from '../observations/schemas';
import type { CompanyReconciler } from '../reconciliation/company-reconciler';
import { COMPANY_DIRECTORY_PARSER } from '../sources/providers/company-directory';
import { isAcceptedDirectoryDomain } from '../sources/providers/directory-values';
import {
  COMPANY_RESOLVER_VERSION,
  type CompanyCandidate,
  resolveCompanyCandidate,
} from '../resolution/company-resolver';
import { HISTORY_ATTACHMENT_VERSION, resolveHistoryAttachment } from '../resolution/history-attachment';
import type { ReviewRepository } from '../review/review.repository';
import type { CompanyService } from './company.service';

export type CompanyProcessOutcome =
  | {
      outcome: 'matched' | 'created';
      observationId: string;
      companyId: string;
      method: string;
      reconciled: boolean;
    }
  | { outcome: 'review'; observationId: string; reviewItemId: string }
  | { outcome: 'already_resolved'; observationId: string; companyId: string; reconciled: boolean };

export interface ResolveOptions {
  /** Resolve to a high-severity review with this reason (see `CompanyCandidate.forceReview`). */
  forceReview?: string;
}

/** Outcome of attaching a history row (M11.5): never `created`. */
export type HistoryAttachOutcome =
  Exclude<CompanyProcessOutcome, { outcome: 'created' }> | { outcome: 'unmatched'; reason: string };

export function candidateFromPayload(p: CompanyObservationPayload): CompanyCandidate {
  const loc =
    p.locations.find((l) => l.kind === 'hq') ??
    p.locations.find((l) => l.kind === 'registered') ??
    p.locations[0];
  return {
    name: p.name,
    aliases: p.aliases,
    domain: p.domain ?? p.website ?? null,
    externalIds: p.externalIds,
    country: loc?.country ?? p.sponsorLicence?.country ?? null,
    hqCountry:
      (p.locations.find((l) => l.kind === 'hq') ?? p.locations.find((l) => l.kind === 'registered'))
        ?.country ?? null,
    town: p.sponsorLicence?.town ?? loc?.city ?? null,
  };
}

/**
 * The domain a company observation contributes as identity evidence. For a directory row
 * (DECISION_LOG "Company directory identity is structural") only the explicitly mapped Domain
 * column counts — never the Website — and it must still pass the directory refusal list (defence in
 * depth). Every other provider: its domain, else its website's.
 */
export function identityDomainOf(
  observation: Pick<CompanyObservationDoc, 'payload' | 'parser'>,
): string | null {
  const p = observation.payload;
  if (observation.parser.name !== COMPANY_DIRECTORY_PARSER.name) return p.domain ?? p.website ?? null;
  return p.domain && isAcceptedDirectoryDomain(p.domain) ? p.domain : null;
}

/**
 * The resolution candidate of a stored observation. A directory row is flagged `directoryRow`
 * (bare names and name-less domain/id hits go to review) and carries only its Domain column as
 * domain evidence (`identityDomainOf`).
 */
export function candidateOf(
  observation: Pick<CompanyObservationDoc, 'payload' | 'parser'>,
): CompanyCandidate {
  const candidate = candidateFromPayload(observation.payload);
  if (observation.parser.name !== COMPANY_DIRECTORY_PARSER.name) return candidate;
  const p = observation.payload;
  return {
    ...candidate,
    // The Legal name column counts for ownership (DECISION_LOG re-verification #4 condition a).
    legalName: p.legalName && p.legalName !== p.name ? p.legalName : null,
    domain: identityDomainOf(observation),
    directoryRow: true,
  };
}

/**
 * Source → Observation → Resolution → Reconciliation for one company record.
 * Each step is idempotent, so the whole pipeline is safe to retry.
 */
export class CompanyPipeline {
  constructor(
    private readonly ctx: MarketContext,
    private readonly observations: ObservationService,
    private readonly companies: CompanyService,
    private readonly reconciler: CompanyReconciler,
    private readonly reviews: ReviewRepository,
  ) {}

  async process(
    input: RecordObservationInput<CompanyObservationPayload>,
    opts: ResolveOptions = {},
  ): Promise<CompanyProcessOutcome> {
    // History evidence is attach-only (M11.5): it never goes through the creating resolver.
    if (input.payload.sponsorshipHistory)
      throw new InvalidStateError('Sponsorship history rows are attach-only (use attachHistory)');
    const { observation, created } = await this.observations.recordCompanyObservation(input);
    if (observation.resolution.state === 'resolved' && observation.resolution.entityId) {
      const company = await this.companies.resolveActive(observation.resolution.entityId);
      const reconciled = created || (await this.needsReconcile(observation, company._id));
      if (reconciled) await this.reconciler.reconcile(company._id);
      return {
        outcome: 'already_resolved',
        observationId: observation._id,
        companyId: company._id,
        reconciled,
      };
    }
    if (observation.resolution.state === 'rejected') {
      return {
        outcome: 'review',
        observationId: observation._id,
        reviewItemId: observation.resolution.reviewItemId ?? '',
      };
    }
    return this.resolveObservation(observation, opts);
  }

  /** Resolve (or re-resolve) a stored observation against canonical companies. */
  async resolveObservation(
    observation: CompanyObservationDoc,
    opts: ResolveOptions = {},
  ): Promise<CompanyProcessOutcome> {
    if (observation.payload.sponsorshipHistory)
      throw new InvalidStateError(
        `Observation ${observation._id} is sponsorship history: attach-only, never resolved by creation`,
      );
    const candidate: CompanyCandidate = {
      ...candidateOf(observation),
      ...(opts.forceReview ? { forceReview: opts.forceReview } : {}),
    };
    // A contradiction on the last attempt still ends in its high review (one more, forced, pass).
    let attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const decision = await resolveCompanyCandidate(candidate, this.companies);
      if (decision.kind === 'review') {
        const { item } = await this.reviews.raise({
          type: 'company_resolution',
          severity: decision.severity,
          dedupeKey: decision.dedupeKey,
          entity: { kind: 'observation', id: observation._id },
          subject: `Resolve company "${observation.payload.name}"`,
          reason: decision.reason,
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
          candidates: decision.candidates.map((c) => ({
            kind: 'company' as const,
            id: c.id,
            label: c.label,
            score: c.score,
            details: { method: c.method },
          })),
          observationIds: [observation._id],
          context: { candidate: JSON.parse(JSON.stringify(candidate)) },
          allowedActions: ['merge', 'create_new', 'reject', 'dismiss'],
        });
        await this.observations.setCompanyResolution([observation._id], {
          state: 'review',
          reviewItemId: item._id,
          resolverVersion: COMPANY_RESOLVER_VERSION,
        });
        return { outcome: 'review', observationId: observation._id, reviewItemId: item._id };
      }
      let companyId: string;
      let method: string;
      let confidence: 'high' | 'medium' | 'low' = 'high';
      if (decision.kind === 'match') {
        companyId = decision.companyId;
        method = decision.method;
        confidence = decision.confidence;
      } else {
        const createdCompany = await this.companies.createFromCandidate(candidate);
        if (!createdCompany) continue; // lost a creation race; re-resolve and match the winner
        companyId = createdCompany._id;
        method = 'created';
      }
      try {
        // The link claims the observation's register-id keys in its transaction: if another
        // company took one meanwhile, nothing is linked and the observation re-resolves.
        await this.observations.setCompanyResolution(
          [observation._id],
          {
            state: 'resolved',
            entityId: companyId,
            method,
            confidence,
            resolverVersion: COMPANY_RESOLVER_VERSION,
          },
          { claimKeys: true },
        );
      } catch (err) {
        if (err instanceof ContradictingIdError) {
          // The company took a contradicting id meanwhile (a concurrent row): never link — the
          // observation goes to a high-severity review (DECISION_LOG af1b342).
          metrics.inc('company_link_contradicting_id_total');
          candidate.forceReview = `${err.message} (a concurrent import linked it first)`;
          attempts = Math.max(attempts, attempt + 2);
          continue;
        }
        if (!isDuplicateKeyError(err)) throw err;
        metrics.inc('company_link_key_claim_conflicts_total');
        continue;
      }
      await this.reconciler.reconcile(companyId);
      return {
        outcome: decision.kind === 'match' ? 'matched' : 'created',
        observationId: observation._id,
        companyId,
        method,
        reconciled: true,
      };
    }
    throw new Error(`Company resolution for ${observation._id} did not converge`);
  }

  /**
   * Attach one history-register row (M11.5): decide the match first (`resolveHistoryAttachment`,
   * attach-only — never a company creation), then record the observation only for a match or a
   * review. An unmatched row leaves no observation (the raw snapshot keeps it) and is re-evaluated
   * by the next import. An observation already resolved, in review or rejected keeps its state.
   */
  async attachHistory(
    input: RecordObservationInput<CompanyObservationPayload>,
    register: string,
  ): Promise<HistoryAttachOutcome> {
    const p = input.payload;
    const h = p.sponsorshipHistory;
    if (!h) throw new Error('attachHistory needs a sponsorshipHistory payload');
    const decision = await resolveHistoryAttachment(
      {
        name: p.name,
        state: h.state ?? null,
        country: h.country,
      },
      this.companies.historyLookup(),
      register,
    );
    if (decision.kind === 'unmatched') return { outcome: 'unmatched', reason: decision.reason };
    const { observation, created } = await this.observations.recordCompanyObservation(input);
    const state = observation.resolution.state;
    if (state === 'resolved' && observation.resolution.entityId) {
      const company = await this.companies.resolveActive(observation.resolution.entityId);
      if (created) await this.reconciler.reconcile(company._id);
      return {
        outcome: 'already_resolved',
        observationId: observation._id,
        companyId: company._id,
        reconciled: created,
      };
    }
    if (state === 'review' || state === 'rejected')
      return {
        outcome: 'review',
        observationId: observation._id,
        reviewItemId: observation.resolution.reviewItemId ?? '',
      };
    if (decision.kind === 'match') {
      await this.observations.setCompanyResolution([observation._id], {
        state: 'resolved',
        entityId: decision.companyId,
        method: decision.method,
        confidence: 'high',
        resolverVersion: HISTORY_ATTACHMENT_VERSION,
      });
      await this.reconciler.reconcile(decision.companyId);
      return {
        outcome: 'matched',
        observationId: observation._id,
        companyId: decision.companyId,
        method: decision.method,
        reconciled: true,
      };
    }
    const { item } = await this.reviews.raise({
      type: 'company_resolution',
      severity: decision.severity,
      dedupeKey: decision.dedupeKey,
      entity: { kind: 'observation', id: observation._id },
      subject: `Attach ${h.route} history of "${p.name}" (${h.state ?? h.country}) to a company?`,
      reason: `${decision.reason}. History rows never create companies: merge into the right company, or reject.`,
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
      candidates: decision.candidates.map((c) => ({
        kind: 'company' as const,
        id: c.id,
        label: c.label,
        score: c.score,
        details: { method: c.method },
      })),
      observationIds: [observation._id],
      context: {
        attachOnly: true,
        register,
        candidate: { name: p.name, state: h.state ?? null, country: h.country },
      },
      // Attach-only: no `create_new`.
      allowedActions: ['merge', 'reject', 'dismiss'],
    });
    await this.observations.setCompanyResolution([observation._id], {
      state: 'review',
      reviewItemId: item._id,
      resolverVersion: HISTORY_ATTACHMENT_VERSION,
    });
    return { outcome: 'review', observationId: observation._id, reviewItemId: item._id };
  }

  /** Re-seen observations only require reconciliation if they could change canonical state. */
  private async needsReconcile(o: CompanyObservationDoc, companyId: string): Promise<boolean> {
    if (!o.payload.sponsorLicence) return false;
    const company = await this.companies.get(companyId);
    const lic = company.employment.sponsorship.licences.find(
      (l) => l.register === o.payload.sponsorLicence?.register && l.route === o.payload.sponsorLicence?.route,
    );
    return !lic || lic.status !== 'listed';
  }

  get context(): MarketContext {
    return this.ctx;
  }
}
