import { DAY_MS, deterministicId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError } from '@aptamind/db';
import type { EvidenceReference } from '@aptamind/provenance';
import { companiesCollection } from '../companies/company.schema';
import type { MarketContext } from '../context';
import { jobsCollection } from '../jobs/job.schema';
import {
  COMPANY_CHANGE_CURSOR_ID,
  companySignalStateCollection,
  SIGNAL_SCHEMA_VERSION,
  type SignalDoc,
  signalWriterCursorsCollection,
  signalsCollection,
} from './schemas';

export const COMPANY_CHANGE_SIGNAL_WRITER = 'company-change/1';

/** Hiring acceleration: at least this many jobs first seen in 7 days … */
export const ACCELERATION_MIN_RECENT = 5;
/** … and at least this multiple of the weekly average of the 28 days before. */
export const ACCELERATION_RATIO = 2;

export interface CompanyChangeResult {
  scanned: number;
  baselined: number;
  written: Record<string, number>;
  skippedNoEvidence: number;
}

interface CurrentState {
  capability: string;
  remotePolicy: string | null;
  roleFamilies: Map<string, { jobId: string; sourceId: string; at: Date }>;
  locations: Map<string, { jobId: string; sourceId: string; at: Date }>;
  recent7: number;
  prior28: number;
  recentJob: { jobId: string; sourceId: string; at: Date } | null;
}

/**
 * OPS-4 canonical-change signals (vocabulary v1), deterministic, no AI: compares each company's
 * canonical record and its open jobs with the state the writer saw last time.
 *  - `sponsorship_change`: the company's sponsorship capability value changed (fact evidence).
 *  - `remote_policy_change`: the company's remote policy fact changed (fact evidence).
 *  - `role_family_expansion`: an open job in a role family the company had no open job in.
 *  - `new_location_hiring`: an open job in a country/city the company had no open job in.
 *  - `hiring_acceleration`: ≥ 5 jobs first seen in the last 7 days and ≥ 2× the weekly average
 *    of the 28 days before (one per company per 7-day window). Not on the first comparison
 *    after baseline, and not when that prior window is empty (the ratio would be vacuous).
 * A company's first pass records a baseline only. Each signal's dedupe key includes the state
 * revision it was computed against, and the state advances by compare-and-set after the signals
 * are written: a crash between the two replays the same keys. No evidence → no signal, and that
 * field stays at the previous value so a later pass retries it once evidence exists. Other
 * fields still advance. Funding and team/leadership signals need sources that do not exist yet
 * (not written).
 *
 * The daily pass resumes from the last company id it finished and wraps to the start when the
 * id space is exhausted, so a timeout does not rescan the same prefix forever.
 */
export class CompanyChangeSignalWriter {
  constructor(private readonly ctx: MarketContext) {}

  private get signals() {
    return getCollection(this.ctx.db, signalsCollection);
  }
  private get state() {
    return getCollection(this.ctx.db, companySignalStateCollection);
  }
  private get cursors() {
    return getCollection(this.ctx.db, signalWriterCursorsCollection);
  }

  private async current(companyId: string, now: Date): Promise<CurrentState> {
    const c = await getCollection(this.ctx.db, companiesCollection).findOne(
      { _id: companyId },
      { projection: { 'employment.sponsorship.capability': 1, 'employment.remotePolicy': 1 } },
    );
    const jobs = await getCollection(this.ctx.db, jobsCollection)
      .find(
        { companyId, status: 'active', 'lifecycle.state': { $ne: 'CLOSED' } },
        {
          projection: {
            'identity.roleFamily.value': 1,
            'geography.normalizedLocations': 1,
            'lifecycle.firstSeenAt': 1,
            sourceRefs: { $slice: 1 },
          },
        },
      )
      .sort({ 'lifecycle.firstSeenAt': 1, _id: 1 })
      .toArray();
    const roleFamilies = new Map<string, { jobId: string; sourceId: string; at: Date }>();
    const locations = new Map<string, { jobId: string; sourceId: string; at: Date }>();
    let recent7 = 0;
    let prior28 = 0;
    let recentJob: CurrentState['recentJob'] = null;
    for (const j of jobs) {
      const sourceId = j.sourceRefs?.[0]?.sourceId;
      if (!sourceId) continue;
      const at = j.lifecycle.firstSeenAt;
      const ref = { jobId: j._id, sourceId, at };
      const fam = j.identity?.roleFamily?.value;
      if (fam && !roleFamilies.has(fam)) roleFamilies.set(fam, ref);
      for (const l of j.geography?.normalizedLocations ?? []) {
        if (!l.country) continue;
        const key = `${l.country}|${(l.city ?? '').toLowerCase()}`;
        if (!locations.has(key)) locations.set(key, ref);
      }
      const age = now.getTime() - at.getTime();
      if (age >= 0 && age < 7 * DAY_MS) {
        recent7++;
        recentJob = ref;
      } else if (age >= 7 * DAY_MS && age < 35 * DAY_MS) prior28++;
    }
    return {
      capability: c?.employment?.sponsorship?.capability?.value ?? 'unknown',
      remotePolicy: c?.employment?.remotePolicy?.value ?? null,
      roleFamilies,
      locations,
      recent7,
      prior28,
      recentJob,
    };
  }

  private factEvidence(c: unknown): EvidenceReference[] {
    return ((c as { evidence?: EvidenceReference[] } | undefined)?.evidence ?? []).slice(0, 5);
  }

  /**
   * `no_evidence` leaves the caller's stored field unchanged so the diff is retried.
   * `duplicate` is a signal already written (advance). `written` is a new signal.
   */
  private async emit(
    out: CompanyChangeResult,
    companyId: string,
    type: SignalDoc['type'],
    dedupeKey: string,
    evidence: EvidenceReference[],
    facts: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<'written' | 'duplicate' | 'no_evidence'> {
    const ev = evidence.filter((e) => e.sourceId);
    if (!ev.length) {
      out.skippedNoEvidence++;
      return 'no_evidence';
    }
    const now = this.ctx.clock.now();
    try {
      await this.signals.insertOne({
        _id: deterministicId('sig', dedupeKey),
        type,
        companyIds: [companyId],
        sourceId: ev[0]!.sourceId,
        evidence: ev,
        occurredAt,
        observedAt: now,
        facts: { writer: COMPANY_CHANGE_SIGNAL_WRITER, ...facts } as SignalDoc['facts'],
        confidence: { level: 'high', reasons: ['deterministic change of canonical data'] },
        state: 'new',
        dedupeKey,
        schemaVersion: SIGNAL_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      out.written[type] = (out.written[type] ?? 0) + 1;
      return 'written';
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      return 'duplicate';
    }
  }

  private jobEvidence(r: { jobId: string; sourceId: string; at: Date }): EvidenceReference[] {
    return [{ sourceId: r.sourceId, locator: `job:${r.jobId}`, observedAt: r.at }];
  }

  async processCompany(companyId: string, out: CompanyChangeResult): Promise<void> {
    const now = this.ctx.clock.now();
    const cur = await this.current(companyId, now);
    const prev = await this.state.findOne({ _id: companyId });
    if (!prev) {
      try {
        await this.state.insertOne({
          _id: companyId,
          writer: COMPANY_CHANGE_SIGNAL_WRITER,
          capability: cur.capability,
          remotePolicy: cur.remotePolicy,
          roleFamilies: [...cur.roleFamilies.keys()].sort(),
          locations: [...cur.locations.keys()].sort(),
          rev: 1,
          createdAt: now,
          updatedAt: now,
        });
        out.baselined++;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
      return;
    }
    const k = (type: string, detail: string) => `co:${companyId}:${type}:${detail}:r${prev.rev}`;
    const company = await getCollection(this.ctx.db, companiesCollection).findOne(
      { _id: companyId },
      { projection: { 'employment.sponsorship.capability': 1, 'employment.remotePolicy': 1 } },
    );
    // A change with no evidence keeps the previous value so the next pass still sees the diff.
    let capability = cur.capability;
    if (prev.capability !== cur.capability) {
      const status = await this.emit(
        out,
        companyId,
        'sponsorship_change',
        k('sponsorship', `${prev.capability}->${cur.capability}`),
        this.factEvidence(company?.employment?.sponsorship?.capability),
        { from: prev.capability, to: cur.capability },
        now,
      );
      if (status === 'no_evidence') capability = prev.capability;
    }
    let remotePolicy = cur.remotePolicy;
    if (prev.remotePolicy !== cur.remotePolicy && cur.remotePolicy !== null) {
      const status = await this.emit(
        out,
        companyId,
        'remote_policy_change',
        k('remote', contentKey(`${prev.remotePolicy}->${cur.remotePolicy}`)),
        this.factEvidence(company?.employment?.remotePolicy),
        { from: prev.remotePolicy, to: cur.remotePolicy },
        now,
      );
      if (status === 'no_evidence') remotePolicy = prev.remotePolicy;
    }
    const seenFam = new Set(prev.roleFamilies);
    const roleFamilies: string[] = [];
    for (const [fam, ref] of cur.roleFamilies) {
      if (!seenFam.has(fam)) {
        const status = await this.emit(
          out,
          companyId,
          'role_family_expansion',
          k('family', fam),
          this.jobEvidence(ref),
          { roleFamily: fam, jobId: ref.jobId },
          ref.at,
        );
        if (status === 'no_evidence') continue;
      }
      roleFamilies.push(fam);
    }
    const seenLoc = new Set(prev.locations);
    const locations: string[] = [];
    for (const [loc, ref] of cur.locations) {
      if (!seenLoc.has(loc)) {
        const status = await this.emit(
          out,
          companyId,
          'new_location_hiring',
          k('location', loc),
          this.jobEvidence(ref),
          { location: loc, jobId: ref.jobId },
          ref.at,
        );
        if (status === 'no_evidence') continue;
      }
      locations.push(loc);
    }
    // rev 1 is the baseline. The next pass is the first comparison: not a burst. A zero prior
    // window makes `recent7 >= 2 * (prior28 / 4)` true for any recent7.
    const firstComparison = prev.rev === 1;
    const weeklyPrior = cur.prior28 / 4;
    if (
      !firstComparison &&
      cur.prior28 > 0 &&
      cur.recentJob &&
      cur.recent7 >= ACCELERATION_MIN_RECENT &&
      cur.recent7 >= ACCELERATION_RATIO * weeklyPrior
    ) {
      const window = Math.floor(now.getTime() / (7 * DAY_MS));
      await this.emit(
        out,
        companyId,
        'hiring_acceleration',
        `co:${companyId}:acceleration:w${window}`,
        this.jobEvidence(cur.recentJob),
        { recent7: cur.recent7, prior28: cur.prior28 },
        now,
      );
    }
    await this.state.updateOne(
      { _id: companyId, rev: prev.rev },
      {
        $set: {
          writer: COMPANY_CHANGE_SIGNAL_WRITER,
          capability,
          remotePolicy,
          roleFamilies: roleFamilies.sort(),
          locations: locations.sort(),
          updatedAt: now,
        },
        $inc: { rev: 1 },
      },
    );
  }

  private async companyCursor(): Promise<string> {
    const doc = await this.cursors.findOne({ _id: COMPANY_CHANGE_CURSOR_ID });
    return doc?.companyId ?? '';
  }

  private async saveCompanyCursor(companyId: string): Promise<void> {
    await this.cursors.updateOne(
      { _id: COMPANY_CHANGE_CURSOR_ID },
      { $set: { companyId, updatedAt: this.ctx.clock.now() } },
      { upsert: true },
    );
  }

  /**
   * One pass over active companies (keyset by id), at most `maxCompanies`.
   * Without `companyIds`, resumes from the stored company id and, when the id space is
   * exhausted, stores `''` so the next pass starts at the beginning. An explicit id list does
   * not move that cursor.
   */
  async run(opts: { maxCompanies?: number; companyIds?: string[] } = {}): Promise<CompanyChangeResult> {
    const out: CompanyChangeResult = { scanned: 0, baselined: 0, written: {}, skippedNoEvidence: 0 };
    const max = opts.maxCompanies ?? 50_000;
    if (opts.companyIds) {
      for (const id of opts.companyIds) {
        out.scanned++;
        await this.processCompany(id, out);
      }
      return out;
    }
    const companies = getCollection(this.ctx.db, companiesCollection);
    let after = await this.companyCursor();
    while (out.scanned < max) {
      const limit = Math.min(500, max - out.scanned);
      const page = await companies
        .find({ _id: { $gt: after }, status: 'active' }, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray();
      if (!page.length) {
        if (after !== '') {
          after = '';
          await this.saveCompanyCursor('');
        }
        break;
      }
      for (const c of page) {
        out.scanned++;
        await this.processCompany(c._id, out);
        after = c._id;
        await this.saveCompanyCursor(after);
      }
    }
    this.ctx.logger.info({ ...out, cursor: after }, 'market company change signals');
    return out;
  }
}

function contentKey(s: string): string {
  return deterministicId('rp', s);
}
