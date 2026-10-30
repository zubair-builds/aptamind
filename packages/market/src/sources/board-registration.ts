import type { Actor } from '@aptamind/contracts';
import type { CompanyDoc } from '../companies/company.schema';
import { boardSourceIdentity, getAdapter } from '../connectors';
import type { AtsProvider } from '../contracts/common';
import type { SourceDoc } from './source.schema';
import type { ReviewRepository } from '../review/review.repository';
import type { SourceService } from './source.service';

export type BoardIdentity = ReturnType<typeof boardSourceIdentity>;

/**
 * The board's source identity (key, region, listing URL).
 *
 * @throws Error when `apiBase` is not one of the provider's known API hosts.
 */
export function atsBoardIdentity(
  provider: AtsProvider,
  boardToken: string,
  apiBase?: string | null,
): BoardIdentity {
  return boardSourceIdentity(getAdapter(provider), boardToken, apiBase);
}

/**
 * Register an ATS board as a scheduled job source of `company` (idempotent on the board key).
 * Shared by careers discovery (`register_job_source`) and the known-board import (M8.2). An
 * existing source is returned unchanged, whichever company it belongs to: callers decide what a
 * different owner means.
 */
export async function registerAtsBoard(
  sources: SourceService,
  input: {
    company: CompanyDoc;
    provider: AtsProvider;
    boardToken: string;
    identity: BoardIdentity;
    refreshIntervalMinutes: number;
    enableSchedule: boolean;
  },
  actor: Actor,
): Promise<{ source: SourceDoc; created: boolean }> {
  const { company, provider, boardToken, identity } = input;
  const regional = identity.region !== 'default';
  const name = company.identity.displayName.value ?? company.identity.normalizedName;
  const { source, created } = await sources.register(
    {
      key: identity.key,
      name: `${name} (${provider}${regional ? ` ${identity.region.toUpperCase()}` : ''})`,
      category: 'job_source',
      provider,
      endpoint: { url: identity.listingUrl, boardToken },
      acquisition: { workflowKey: 'market.ats.refresh' },
      companyId: company._id,
      schedule: input.enableSchedule
        ? { intervalMinutes: input.refreshIntervalMinutes, timezone: 'UTC' }
        : undefined,
      freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 36 * 60 },
      authority: {
        tier: 'official_ats',
        authoritativeFor: ['job existence', 'job content', 'requirements'],
        listingIsComplete: true,
      },
      governance: { accessMethod: 'public_api', termsNotes: `${provider} public job board API` },
    },
    actor,
  );
  return { source, created };
}

/**
 * A board that already belongs to another company: one review per (board, company pair), shared
 * by discovery and the known-board import so both raise the same item.
 */
export async function raiseBoardOwnerReview(
  reviews: ReviewRepository,
  source: SourceDoc,
  company: CompanyDoc,
  reason: string,
): Promise<string> {
  const name = company.identity.displayName.value ?? company.identity.normalizedName;
  const owner = source.companyId ?? 'none';
  const { item } = await reviews.raise({
    type: 'careers_discovery',
    severity: 'medium',
    dedupeKey: `careers_discovery:board:${source.key}:${[owner, company._id].sort().join(':')}`,
    entity: { kind: 'company', id: company._id },
    subject: `${name}: ATS board ${source.key} already belongs to another company`,
    reason,
    candidates: source.companyId ? [{ kind: 'company', id: source.companyId, label: source.companyId }] : [],
    context: { sourceId: source._id },
    allowedActions: ['confirm', 'dismiss'],
  });
  return item._id;
}
