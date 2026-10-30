import { readFileSync } from 'node:fs';
import path from 'node:path';
import { emptyCompany } from '../companies/company.service';
import { interpretJob } from '../enrichment/interpret';
import { getPath, matchExpectation } from '../enrichment/golden';
import type { CompanyObservationDoc, JobObservationDoc } from '../observations/schemas';
import { buildCanonicalCompany } from '../reconciliation/company-reconciler';
import { interpretationInput } from '../reconciliation/interpretation-input';
import type { SourceDoc } from '../sources/source.schema';
import { keepEvidenceRows, registerAdapterById, type RegisterRow } from '../sources/providers/registers';
import type { GoldenResult } from './evaluators';

/**
 * Register evidence golden suite (M8.4): register file (or rows) → register adapter (parser,
 * route taxonomy, identity) → company observations → company reconciliation
 * (`buildCanonicalCompany`) → the interpretation input reconciliation builds
 * (`interpretationInput`) → job interpretation. It pins what a register listing may and may not
 * mean for a job, end to end, without a database.
 *
 * A case: `imports[]` (`register` id with a `fixture` path under `fixtures/` or inline `rows`,
 * optionally `select` = the organisation names to keep: all kept rows are one company), `company`
 * expectations (dotted paths on the canonical company) and `jobs[]` (location texts, optional
 * description, expectations on the interpretation). Expectation syntax: the interpretation golden's.
 */

interface RegisterGoldenCase {
  id: string;
  description: string;
  imports: Array<{
    register: string;
    fixture?: string;
    /** Inline file content (parsed by the adapter like a snapshot). */
    content?: string;
    rows?: Array<Omit<RegisterRow, 'locator'>>;
    select?: string[];
    /** Source time of the observations (default 2026-09-29T00:00:00Z). */
    observedAt?: string;
    /** The source's latest complete import (licences observed before it are no longer listed). */
    completeImportAt?: string;
  }>;
  company?: Record<string, unknown>;
  jobs?: Array<{
    id: string;
    locationTexts: string[];
    title?: string;
    descriptionText?: string;
    expect: Record<string, unknown>;
  }>;
}

export function evaluateRegisterGolden(dir: string, fixturesDir: string): GoldenResult {
  const g = JSON.parse(readFileSync(path.join(dir, 'registers.json'), 'utf8')) as {
    cases: RegisterGoldenCase[];
  };
  const cases = g.cases.map((c) => {
    const failures: string[] = [];
    const obs: CompanyObservationDoc[] = [];
    const sources = new Map<string, SourceDoc>();
    c.imports.forEach((imp, k) => {
      const adapter = registerAdapterById(imp.register);
      if (!adapter) {
        failures.push(`unknown register ${imp.register}`);
        return;
      }
      const sourceId = `src_golden_${k}`;
      sources.set(sourceId, {
        _id: sourceId,
        provider: adapter.provider,
        authority: { tier: 'official_registry' },
        health: imp.completeImportAt ? { lastCompleteImportStartedAt: new Date(imp.completeImportAt) } : {},
      } as unknown as SourceDoc);
      const rows: RegisterRow[] = imp.fixture
        ? adapter.parse(readFileSync(path.join(fixturesDir, imp.fixture))).rows
        : imp.content !== undefined
          ? adapter.parse(Buffer.from(imp.content)).rows
          : (imp.rows ?? []).map((r, i) => ({ ...r, locator: `inline:${i + 1}` }));
      const selected = imp.select ? rows.filter((r) => imp.select!.includes(r.name)) : rows;
      const at = new Date(imp.observedAt ?? '2026-09-29T00:00:00Z');
      for (const row of keepEvidenceRows(adapter, selected).kept) {
        const mapped = adapter.toObservation(row);
        if (!mapped) continue;
        obs.push({
          _id: `cobs_golden_${k}_${obs.length}`,
          sourceId,
          snapshotId: `snap_golden_${k}`,
          artifactId: `art_golden_${k}`,
          locator: row.locator,
          externalId: mapped.externalId,
          contentHash: `golden_${obs.length}`,
          firstObservedAt: at,
          lastObservedAt: at,
          sourceObservedAt: at,
          seenCount: 1,
          parser: adapter.parser,
          warnings: [],
          resolution: { state: 'resolved', entityId: 'cmp_golden' },
          payload: mapped.payload,
          schemaVersion: 1,
        } as unknown as CompanyObservationDoc);
      }
    });
    const now = new Date('2026-09-30T00:00:00Z');
    const company = buildCanonicalCompany(
      emptyCompany('cmp_golden', obs[0]?.payload.name ?? c.id, [], now),
      obs,
      sources,
      now,
    );
    for (const [p, expected] of Object.entries(c.company ?? {})) {
      const f = matchExpectation(getPath(company, p), expected);
      if (f) failures.push(`company.${p}: ${f}`);
    }
    for (const job of c.jobs ?? []) {
      const copy = {
        payload: {
          externalId: job.id,
          title: job.title ?? 'Software Engineer',
          locations: job.locationTexts.map((text) => ({ text })),
          descriptionText: job.descriptionText ?? 'Build and run our platform with a small product team.',
          provider: { name: 'greenhouse', boardToken: 'golden' },
        },
      } as unknown as JobObservationDoc;
      const interpretation = interpretJob(interpretationInput(copy, company));
      for (const [p, expected] of Object.entries(job.expect)) {
        const f = matchExpectation(getPath(interpretation, p), expected);
        if (f) failures.push(`job ${job.id} ${p}: ${f}`);
      }
    }
    return { id: c.id, passed: failures.length === 0, failures };
  });
  return {
    suite: 'register-evidence',
    cases,
    passed: cases.filter((x) => x.passed).length,
    failed: cases.filter((x) => !x.passed).length,
  };
}
