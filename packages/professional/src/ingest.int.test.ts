/**
 * P1.3 ingest on a real runtime (Mongo/Redis/S3): statements and uploads launch
 * `professional.source.ingest`; form snapshots become `stated` observations with full
 * provenance; re-ingest writes nothing; documents are recorded as skipped until P2.1; a failed
 * launch leaves a visible unprocessed snapshot that reprocess recovers; and with every node's
 * first completion acknowledgement lost, the final state equals the fault-free one.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, deterministicId, newId } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { TerminalError } from '@aptamind/workflow-sdk';
import { ExtractionService } from './extraction/extraction.service';
import { atPointer } from './structured/extractor';
import { createProfessionalTestRuntime } from './test-harness';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

const consent = { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' } as const;
const questionnaire = {
  form: 'questionnaire',
  version: 1,
  answers: {
    headline: 'Senior product designer',
    current_location: { city: 'Dubai', country: 'AE' },
    languages: [{ label: 'English', proficiency: 'fluent' }],
    skills: [{ label: 'Figma', kind: 'tool' }, { label: 'Service blueprints' }],
  },
};

async function setup(label: string, opts: Parameters<typeof createProfessionalTestRuntime>[1] = {}) {
  const infra: TestInfra = await createTestInfra(label);
  const t = await createProfessionalTestRuntime(infra, opts);
  cleanups.push(async () => {
    await t.stop();
    await infra.cleanup();
  });
  const p = t.professional;
  const { subject } = await p.subjects.create({ reference: `${label}-subject`, consent }, t.actor);
  const form = (await p.sources.register(subject._id, { kind: 'questionnaire' }, t.actor)).source;
  const cv = (await p.sources.register(subject._id, { kind: 'cv' }, t.actor)).source;
  return { infra, t, p, subject, form, cv };
}

/** Lose the first completion acknowledgement of every node run (at-least-once execution). */
type Engine = Awaited<ReturnType<typeof createProfessionalTestRuntime>>['runtime']['engine'];
function loseFirstAcks(engine: Engine): { lost: number } {
  const faults = { lost: 0 };
  const nodeRuns = engine.stores.nodeRuns;
  const finish = nodeRuns.finish.bind(nodeRuns);
  const acked = new Set<string>();
  nodeRuns.finish = async (fence, state, ...rest) => {
    if (state === 'COMPLETED' && !acked.has(fence.nodeRunId)) {
      acked.add(fence.nodeRunId);
      faults.lost += 1;
      throw new Error('injected: acknowledgement lost');
    }
    return finish(fence, state, ...rest);
  };
  return faults;
}

describe('professional.source.ingest', () => {
  it('turns a questionnaire into stated observations with full provenance; re-ingest writes nothing', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_form');
    const r = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    expect(r).toMatchObject({ created: true, snapshot: { via: 'form', mimeType: 'application/json' } });
    expect(r.runId).toMatch(/^run_/);
    expect((await t.wait(r.runId!)).state).toBe('COMPLETED');

    const snapshot = await p.snapshots.get(r.snapshot._id);
    expect(snapshot.ingest).toMatchObject({ state: 'launched', runId: r.runId });
    const extraction = await p.extractions.col.findOne({ snapshotId: snapshot._id });
    expect(extraction).toMatchObject({
      _id: ExtractionService.structuredExtractionId(snapshot._id),
      status: 'completed',
      current: true,
      extractor: { name: 'structured_form', version: 1, kind: 'deterministic' },
      counts: { observations: 5 },
    });
    const observations = await p.observations.col.find({ snapshotId: snapshot._id }).toArray();
    expect(observations.map((o) => o.claimType).sort()).toEqual(
      ['language', 'location.current', 'positioning.headline', 'skill', 'skill'].sort(),
    );
    // Provenance: stated, deterministic extractor, the form artifact, a JSON pointer, the stored field.
    const stored = JSON.parse(new TextDecoder().decode(await p.snapshots.content(snapshot)));
    for (const o of observations) {
      expect(o).toMatchObject({
        subjectId: subject._id,
        sourceId: form._id,
        extractionId: extraction!._id,
        mode: 'stated',
        status: 'current',
        sourceAsOf: snapshot.sourceAsOf,
        resolution: { state: 'pending' },
        runId: r.runId,
        evidence: { artifactId: snapshot.artifact.artifactId, spanVerified: true },
      });
      const cell = atPointer(stored, o.evidence.locator);
      expect(o.evidence.quote).toBe(typeof cell === 'string' ? cell : canonicalJson(cell)); // N5
    }

    // Re-ingest: a new run, the extraction replays, nothing is written.
    const before = await p.observations.col.countDocuments({});
    const again = await p.ingest.reprocess(snapshot._id, t.actor);
    expect(again.runId).not.toBe(r.runId);
    const rerun = await t.wait(again.runId);
    expect(rerun.state).toBe('COMPLETED');
    expect(await p.observations.col.countDocuments({})).toBe(before);
    expect(await p.extractions.col.countDocuments({ snapshotId: snapshot._id })).toBe(1);
    const node = await t.runtime.engine.nodeRuns.findOne({
      runId: again.runId,
      nodeId: 'extract_structured',
    });
    expect(node?.output).toMatchObject({ replayed: true, observations: 5 });

    // A re-acquisition (same form again) returns the snapshot's ingest run, no new run.
    const reacq = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    expect(reacq).toMatchObject({ created: false, runId: again.runId });
    expect(await t.runtime.engine.runs.countDocuments({ 'labels.sourceId': form._id })).toBe(2);
  });

  it('records uploaded documents as skipped (unsupported_format) until text extraction exists', async () => {
    const { t, p, cv } = await setup('prof_ingest_doc');
    const r = await p.ingest.upload(
      cv._id,
      { bytes: new TextEncoder().encode('Experience\nDesigner at Acme\n'), contentType: 'text/plain' },
      t.actor,
    );
    expect((await t.wait(r.runId!)).state).toBe('COMPLETED');
    expect(await p.extractions.col.findOne({ snapshotId: r.snapshot._id })).toMatchObject({
      status: 'skipped',
      skipReason: 'unsupported_format',
      counts: { observations: 0 },
    });
    expect(await p.observations.col.countDocuments({ snapshotId: r.snapshot._id })).toBe(0);
  });

  it('a failed launch leaves a visible unprocessed snapshot; a re-acquisition or reprocess launches it', async () => {
    let failures = 1;
    const { t, p, subject, form } = await setup('prof_ingest_crash', {
      launcher: (real) => ({
        startRun: async (req) => {
          if (failures-- > 0) throw new Error('injected: crash between snapshot commit and launch');
          return real.startRun(req);
        },
      }),
    });
    const r = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    expect(r).toMatchObject({ created: true, runId: null, snapshot: { ingest: { state: 'pending' } } });
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(1);

    const fixed = await p.ingest.reprocess(r.snapshot._id, t.actor, 'reprocess-key-01');
    expect(fixed.snapshot.ingest).toMatchObject({ state: 'launched', runId: fixed.runId });
    expect((await t.wait(fixed.runId)).state).toBe('COMPLETED');
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(0);
    expect(await p.observations.col.countDocuments({ snapshotId: r.snapshot._id })).toBe(5);
    // The same reprocess key replays the same run.
    expect((await p.ingest.reprocess(r.snapshot._id, t.actor, 'reprocess-key-01')).runId).toBe(fixed.runId);
  });

  it('refuses statements for another subject, the wrong source kind, or invalid forms', async () => {
    const { t, p, subject, form, cv } = await setup('prof_ingest_refuse');
    const other = (await p.subjects.create({ reference: 'prof-ingest-other', consent }, t.actor)).subject;
    const code = async (body: unknown, subjectId = subject._id) =>
      p.ingest.submitStatements(subjectId, body, t.actor).then(
        () => 'ok',
        (err: { code?: string; name?: string }) => err.code ?? err.name,
      );
    expect(await code({ sourceId: form._id, form: questionnaire }, other._id)).toBe('validation_failed');
    expect(await code({ sourceId: cv._id, form: questionnaire })).toBe('validation_failed');
    expect(
      await code({ sourceId: form._id, form: { form: 'manual_input', version: 1, statements: [] } }),
    ).toBe('ZodError');
    expect(await p.snapshots.col.countDocuments({ sourceId: form._id })).toBe(0);
  });
});

describe('ack-failure injection (at-least-once)', () => {
  async function scenario(label: string, inject: boolean) {
    const { t, p, subject, form, cv } = await setup(label);
    const faults = inject ? loseFirstAcks(t.runtime.engine) : { lost: 0 };
    const a = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    const b = await p.ingest.upload(
      cv._id,
      { bytes: new TextEncoder().encode('A plain CV\n'), contentType: 'text/plain' },
      t.actor,
    );
    for (const runId of [a.runId!, b.runId!]) expect((await t.wait(runId)).state).toBe('COMPLETED');
    const strip = <T extends Record<string, unknown>>(d: T) => {
      const {
        createdAt: _c,
        updatedAt: _u,
        completedAt: _d,
        runId: _r,
        at: _a,
        sourceAsOf: _s,
        ...rest
      } = d as Record<string, unknown>;
      // Wall-clock times differ between the two databases; everything else must be equal.
      void [_c, _u, _d, _r, _a, _s];
      return rest;
    };
    const ids = { subject: subject._id, form: form._id, cv: cv._id };
    const norm = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v)
          .split(ids.subject)
          .join('<subject>')
          .split(ids.form)
          .join('<form>')
          .split(ids.cv)
          .join('<cv>'),
      );
    const observations = await p.observations.col
      .find({}, { sort: { claimType: 1, 'evidence.locator': 1 } })
      .toArray();
    const extractions = await p.extractions.col.find({}, { sort: { status: 1 } }).toArray();
    const events = await p.events.col.find({ 'entity.kind': 'extraction' }, { sort: { type: 1 } }).toArray();
    return {
      faults,
      state: norm({
        observations: observations.map((o) => strip({ ...o, _id: 'x', extractionId: 'x', snapshotId: 'x' })),
        extractions: extractions.map((e) => strip({ ...e, _id: 'x', snapshotId: 'x' })),
        events: events.map((e) => ({ type: e.type, to: e.to, reason: e.reason })),
      }),
    };
  }

  it('each capability executing twice yields the fault-free final state', async () => {
    const clean = await scenario('prof_ingest_clean', false);
    const faulty = await scenario('prof_ingest_faulty', true);
    // trigger + load + extract_structured, two runs.
    expect(faulty.faults.lost).toBeGreaterThanOrEqual(6);
    expect(faulty.state).toEqual(clean.state);
  });
});

describe('P1.3 review: processing status, concurrency, launch safety', () => {
  it('derives processing from the ledger: processed, skipped, pending, failed → a re-acquisition retries', async () => {
    let failLaunches = 0;
    const { t, p, subject, form, cv } = await setup('prof_ingest_status', {
      launcher: (real) => ({
        startRun: async (req) => {
          if (failLaunches > 0) {
            failLaunches -= 1;
            throw new Error('injected launch failure');
          }
          return real.startRun(req);
        },
      }),
    });
    const a = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    await t.wait(a.runId!);
    expect((await p.ingest.detail(a.snapshot._id)).processing).toEqual({
      state: 'processed',
      runId: a.runId,
    });
    const doc = await p.ingest.upload(
      cv._id,
      { bytes: new TextEncoder().encode('Plain CV\n'), contentType: 'text/plain' },
      t.actor,
    );
    await t.wait(doc.runId!);
    expect((await p.ingest.detail(doc.snapshot._id)).processing).toMatchObject({
      state: 'skipped',
      reason: 'unsupported_format',
    });
    failLaunches = 1;
    const pending = await p.ingest.upload(
      cv._id,
      { bytes: new TextEncoder().encode('Another CV\n'), contentType: 'text/plain' },
      t.actor,
    );
    expect(pending.snapshot.processing).toEqual({ state: 'pending' });

    // A run that fails before any extraction: processing `failed`; the overview counts it.
    const extract = p.extractions.extractStructured.bind(p.extractions);
    let failExtract = true;
    p.extractions.extractStructured = async (...args) => {
      if (failExtract) {
        failExtract = false;
        throw new TerminalError('injected');
      }
      return extract(...args);
    };
    const failing = { ...questionnaire, answers: { headline: 'Will fail once' } };
    const f = await p.ingest.submitStatements(subject._id, { sourceId: form._id, form: failing }, t.actor);
    expect((await t.wait(f.runId!)).state).toBe('FAILED');
    expect((await p.ingest.detail(f.snapshot._id)).processing).toEqual({
      state: 'failed',
      reason: 'run_failed',
      runId: f.runId,
    });
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(2); // pending + failed

    // Re-acquiring the failed snapshot launches a retry run (keyed on the failed run).
    const again = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: failing },
      t.actor,
    );
    expect(again.created).toBe(false);
    expect(again.runId).not.toBe(f.runId);
    await t.wait(again.runId!);
    expect((await p.ingest.detail(f.snapshot._id)).processing).toEqual({
      state: 'processed',
      runId: again.runId,
    });
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(1);
  });

  it('concurrent extractions of one snapshot: one winner, written once', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_race', {
      launcher: () => ({
        startRun: async () => {
          throw new Error('no runs in this test');
        },
      }),
    });
    const r = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    expect(r.runId).toBeNull();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => p.extractions.extractStructured(r.snapshot._id)),
    );
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(await p.extractions.col.countDocuments({ snapshotId: r.snapshot._id })).toBe(1);
    expect(await p.observations.col.countDocuments({ snapshotId: r.snapshot._id })).toBe(5);
    expect(await p.events.col.countDocuments({ 'entity.kind': 'extraction' })).toBe(1);
    expect((await p.subjects.get(subject._id)).extractionCount).toBe(1);
  });

  it('concurrent acquisitions of one form start one run; a crash after startRun heals to that run', async () => {
    let crashAfterStart = 1;
    const { t, p, subject, form } = await setup('prof_ingest_heal', {
      launcher: (real) => ({
        startRun: async (req) => {
          const run = await real.startRun(req);
          if (crashAfterStart-- > 0) throw new Error('injected crash after startRun');
          return run;
        },
      }),
    });
    const first = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    expect(first.runId).toBeNull(); // the run exists, the snapshot does not know it yet
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        p.ingest.submitStatements(subject._id, { sourceId: form._id, form: questionnaire }, t.actor),
      ),
    );
    const runIds = new Set(results.map((r) => r.runId));
    expect(runIds.size).toBe(1);
    expect(await t.runtime.engine.runs.countDocuments({ 'labels.sourceId': form._id })).toBe(1);
    expect((await p.snapshots.get(first.snapshot._id)).ingest).toMatchObject({
      state: 'launched',
      runId: [...runIds][0],
    });
  });

  it('refuses a returned run that is not this snapshot’s ingest run', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_mismatch', {
      launcher: (real) => ({
        startRun: async (req) => ({ ...(await real.startRun(req)), input: { snapshotId: 'psnap_other' } }),
      }),
    });
    const r = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    expect(r.runId).toBeNull();
    expect((await p.snapshots.get(r.snapshot._id)).ingest?.state).toBe('pending');
    await expect(p.ingest.reprocess(r.snapshot._id, t.actor)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the snapshot records its latest run, whatever order concurrent launches finish in', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_latest');
    const r = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => p.ingest.reprocess(r.snapshot._id, t.actor)),
    );
    const newest = [r.runId!, ...runs.map((x) => x.runId)].sort().at(-1);
    expect((await p.snapshots.get(r.snapshot._id)).ingest?.runId).toBe(newest);
  });

  it('extraction is fenced on an active subject', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_fence', {
      launcher: () => ({
        startRun: async () => {
          throw new Error('no runs');
        },
      }),
    });
    const r = await p.ingest.submitStatements(
      subject._id,
      { sourceId: form._id, form: questionnaire },
      t.actor,
    );
    const stale = await p.subjects.get(subject._id);
    await p.subjects.archive(subject._id, t.actor);
    void stale;
    await expect(p.extractions.extractStructured(r.snapshot._id)).rejects.toMatchObject({
      code: 'subject_archived',
    });
    expect(await p.extractions.col.countDocuments({ snapshotId: r.snapshot._id })).toBe(0);
    expect(await p.observations.col.countDocuments({ snapshotId: r.snapshot._id })).toBe(0);
  });
});

describe('P1.3 re-verify: run failures vs final failures (L2–L4)', () => {
  it('a recorded run whose document is gone is failed (run_missing), counted, and a re-acquisition relaunches', async () => {
    let fake = 1;
    const { t, p, subject, form } = await setup('prof_ingest_run_missing', {
      launcher: (real) => ({
        startRun: async (req) => {
          // The first launch "succeeds" with a run that never existed (e.g. purged later).
          if (fake-- > 0)
            return { _id: newId('run'), workflowKey: req.workflowKey, input: req.input } as never;
          return real.startRun(req);
        },
      }),
    });
    const body = { sourceId: form._id, form: questionnaire };
    const r = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect(r.snapshot.processing).toEqual({ state: 'failed', reason: 'run_missing', runId: r.runId });
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(1);
    const again = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect(again.runId).not.toBe(r.runId);
    expect((await t.wait(again.runId!)).state).toBe('COMPLETED');
    expect((await p.ingest.detail(r.snapshot._id)).processing).toEqual({
      state: 'processed',
      runId: again.runId,
    });
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(0);
  });

  it('a run that completes without recording an extraction is failed (run_ended_without_extraction) and retried', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_run_ended');
    const extract = p.extractions.extractStructured.bind(p.extractions);
    let lie = true;
    p.extractions.extractStructured = async (...args) => {
      if (!lie) return extract(...args);
      lie = false;
      return {
        extractionId: deterministicId('pext', 'never-written'),
        status: 'completed',
        observations: 0,
        replayed: true,
      };
    };
    const body = { sourceId: form._id, form: questionnaire };
    const r = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect((await t.wait(r.runId!)).state).toBe('COMPLETED');
    expect((await p.ingest.detail(r.snapshot._id)).processing).toEqual({
      state: 'failed',
      reason: 'run_ended_without_extraction',
      runId: r.runId,
    });
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(1);
    const again = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect(again.runId).not.toBe(r.runId);
    await t.wait(again.runId!);
    expect((await p.ingest.detail(r.snapshot._id)).processing.state).toBe('processed');
  });

  it('a run that ends between the extraction read and the run-state read is re-read: processed, no retry (L-4)', async () => {
    let launches = 0;
    const { t, p, subject, form } = await setup('prof_ingest_reread', {
      launcher: (real) => ({
        startRun: async (req) => {
          launches += 1;
          if (launches === 1)
            return { _id: newId('run'), workflowKey: req.workflowKey, input: req.input } as never;
          return real.startRun(req);
        },
      }),
    });
    const body = { sourceId: form._id, form: questionnaire };
    const r = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect(launches).toBe(1);
    const snapshotId = r.snapshot._id;
    // The run completes (extraction written) after processing read the ledger and before it
    // read the run's state, which is COMPLETED.
    const ingest = p.ingest as unknown as {
      runs: { states: (ids: readonly string[]) => Promise<Record<string, string>> };
    };
    let raced = 0;
    ingest.runs = {
      states: async (ids) => {
        if (raced++ === 0) await p.extractions.extractStructured(snapshotId, r.runId!);
        return Object.fromEntries(ids.map((id) => [id, 'COMPLETED']));
      },
    };
    expect((await p.ingest.detail(snapshotId)).processing).toEqual({ state: 'processed', runId: r.runId });
    expect(raced).toBe(1);
    // No spurious failure: a re-acquisition starts no retry run, and nothing is unprocessed.
    const again = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect(again).toMatchObject({
      created: false,
      runId: r.runId,
      snapshot: { processing: { state: 'processed' } },
    });
    expect(launches).toBe(1);
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(0);
  });

  it('a failed extraction is final: no automatic retry, reprocess is 409 extraction_failed_final', async () => {
    const { t, p, subject, form, cv } = await setup('prof_ingest_final', {
      launcher: () => ({
        startRun: async () => {
          throw new Error('no runs until the stored form is broken');
        },
      }),
    });
    const body = { sourceId: form._id, form: questionnaire };
    const r = await p.ingest.submitStatements(subject._id, body, t.actor);
    // Break the stored form: point it at bytes that are not JSON (e.g. an old schema's form).
    const doc = await p.ingest.upload(
      cv._id,
      { bytes: new TextEncoder().encode('not json\n'), contentType: 'text/plain' },
      t.actor,
    );
    const broken = await p.snapshots.get(doc.snapshot._id);
    await p.snapshots.col.updateOne({ _id: r.snapshot._id }, { $set: { artifact: broken.artifact } });
    expect(await p.extractions.extractStructured(r.snapshot._id)).toMatchObject({ status: 'failed' });
    const final = { state: 'failed', reason: 'invalid_stored_form', final: true };
    expect((await p.ingest.detail(r.snapshot._id)).processing).toEqual(final);
    // A re-acquisition does not launch (the launcher would throw and leave runId null anyway,
    // so count the attempts).
    let attempts = 0;
    const counting = p.ingest as unknown as { launcher: { startRun: (req: unknown) => Promise<never> } };
    counting.launcher = {
      startRun: async () => {
        attempts += 1;
        throw new Error('must not launch');
      },
    };
    const again = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect(again).toMatchObject({ created: false, runId: null, snapshot: { processing: final } });
    expect(attempts).toBe(0);
    await expect(p.ingest.reprocess(r.snapshot._id, t.actor)).rejects.toMatchObject({
      code: 'extraction_failed_final',
      details: { reason: 'invalid_stored_form' },
    });
    expect(attempts).toBe(0);
    // Still visible as unprocessed (pending document + the final failure).
    expect((await p.overview(subject._id)).counts.unprocessedSnapshots).toBe(2);
  });

  it('concurrent re-acquisitions of a failed snapshot start exactly one retry run', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_retry_race');
    const extract = p.extractions.extractStructured.bind(p.extractions);
    let fail = true;
    p.extractions.extractStructured = async (...args) => {
      if (fail) {
        fail = false;
        throw new TerminalError('injected');
      }
      return extract(...args);
    };
    const body = { sourceId: form._id, form: questionnaire };
    const r = await p.ingest.submitStatements(subject._id, body, t.actor);
    expect((await t.wait(r.runId!)).state).toBe('FAILED');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => p.ingest.submitStatements(subject._id, body, t.actor)),
    );
    const retries = new Set(results.map((x) => x.runId));
    expect(retries.size).toBe(1);
    expect(retries.has(r.runId)).toBe(false);
    // The failed run and one retry: a random retry key would start one run per re-acquisition.
    expect(await t.runtime.engine.runs.countDocuments({ 'labels.sourceId': form._id })).toBe(2);
    await t.wait([...retries][0]!);
    expect((await p.ingest.detail(r.snapshot._id)).processing.state).toBe('processed');
  });
});

describe('sensitive fields (P1.3 re-verify nit)', () => {
  it('a remote preference with a timezone window is private by default; without one it is not', async () => {
    const { t, p, subject, form } = await setup('prof_ingest_tzwindow', {
      launcher: () => ({
        startRun: async () => {
          throw new Error('no runs');
        },
      }),
    });
    const submit = async (remote: object) => {
      const r = await p.ingest.submitStatements(
        subject._id,
        { sourceId: form._id, form: { form: 'questionnaire', version: 1, answers: { remote } } },
        t.actor,
      );
      await p.extractions.extractStructured(r.snapshot._id);
      return (await p.observations.col.findOne({ snapshotId: r.snapshot._id }))!;
    };
    const plain = await submit({ acceptable: ['remote'] });
    const windowed = await submit({
      acceptable: ['remote'],
      timezoneWindow: { minUtcOffset: 3, maxUtcOffset: 5 },
    });
    const ids = async (query: object) =>
      (await p.observations.list(subject._id, { claimType: 'preference.remote', ...query })).items.map(
        (o) => o._id,
      );
    expect(await ids({})).toEqual([plain._id]);
    expect((await ids({ include: 'sensitive' })).sort()).toEqual([plain._id, windowed._id].sort());
    await expect(p.observations.get(windowed._id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await p.observations.get(windowed._id, { includeSensitive: true }))._id).toBe(windowed._id);
    expect((await p.observations.get(plain._id))._id).toBe(plain._id);
  });
});
