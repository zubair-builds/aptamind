/**
 * R-34 canary run (P1.3; required by `privacy/capability-io.test.ts` once any Professional
 * capability exists). Personal values go in through statements and an upload and run through
 * `professional.source.ingest` on the real runtime. Every generic runtime record — runs, node
 * runs (input, output, previews, node logs), chunks, runtime-written artifacts — and every log
 * line must be free of them; the Professional collections are where they belong.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@aptamind/observability';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { createProfessionalTestRuntime } from './test-harness';

const CANARY = `canary${randomBytes(5).toString('hex')}`;
const lines: string[] = [];
const logger = createLogger({
  service: 'prof-canary',
  level: 'trace',
  destination: new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  }),
});

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createProfessionalTestRuntime>>;
beforeAll(async () => {
  const base = await createTestInfra('prof_canary');
  infra = { ...base, logger, cleanup: base.cleanup };
  t = await createProfessionalTestRuntime(infra, { logger });
});
afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

describe('R-34 canary run', () => {
  it('no personal value reaches generic run records, runtime artifacts or logs', async () => {
    const p = t.professional;
    const consent = { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' } as const;
    const { subject } = await p.subjects.create({ reference: 'canary-subject', consent }, t.actor);
    const form = (await p.sources.register(subject._id, { kind: 'questionnaire' }, t.actor)).source;
    const manual = (await p.sources.register(subject._id, { kind: 'manual_input' }, t.actor)).source;
    const cv = (await p.sources.register(subject._id, { kind: 'cv' }, t.actor)).source;

    const runs = [
      await p.ingest.submitStatements(
        subject._id,
        {
          sourceId: form._id,
          form: {
            form: 'questionnaire',
            version: 1,
            answers: {
              headline: `Designer ${CANARY}`,
              current_location: { city: `City${CANARY}`, country: 'AE' },
              skills: [{ label: `Skill${CANARY}` }],
              links: [{ kind: 'website', url: `https://${CANARY}.example/me` }],
            },
          },
        },
        t.actor,
      ),
      await p.ingest.submitStatements(
        subject._id,
        {
          sourceId: manual._id,
          form: {
            form: 'manual_input',
            version: 1,
            statements: [{ claimType: 'identity.name', value: { display: `Persona ${CANARY}` } }],
          },
        },
        t.actor,
      ),
      await p.ingest.upload(
        cv._id,
        {
          bytes: new TextEncoder().encode(`Name: ${CANARY}\nEmail: ${CANARY}@example.org\n`),
          contentType: 'text/plain',
        },
        t.actor,
      ),
    ];
    for (const r of runs) expect((await t.wait(r.runId!)).state).toBe('COMPLETED');
    // A reprocess replays through every node again.
    const again = await p.ingest.reprocess(runs[0]!.snapshot._id, t.actor);
    expect((await t.wait(again.runId)).state).toBe('COMPLETED');

    // The values are where they belong …
    const observations = JSON.stringify(await p.observations.col.find({ subjectId: subject._id }).toArray());
    expect(observations).toContain(CANARY);

    // … and nowhere in the generic runtime's records.
    const generic = (await infra.db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('professional_') && n !== 'artifacts');
    expect(generic).toEqual(expect.arrayContaining(['workflow_runs', 'workflow_node_runs']));
    for (const name of generic) {
      const docs = await infra.db.collection(name).find({}).toArray();
      expect(JSON.stringify(docs), name).not.toContain(CANARY);
    }
    const nodeRuns = await t.runtime.engine.nodeRuns.find({}).toArray();
    expect(nodeRuns.length).toBeGreaterThanOrEqual(12);
    // Node IO is ids and counts: far below the inline limit, so nothing spills to an artifact —
    // the runtime-artifact check below is empty by construction, and this proves why.
    for (const nr of nodeRuns) {
      expect(JSON.stringify(nr.output ?? null).length).toBeLessThan(1024);
      expect((nr as { outputRef?: unknown }).outputRef).toBeUndefined();
    }
    // Runtime-written artifacts (output spills, record sets) carry no personal bytes either.
    const artifacts = infra.db.collection<{ _id: string; context?: { runId?: string } }>('artifacts');
    const runtimeArtifacts = await artifacts.find({ 'context.runId': { $exists: true } }).toArray();
    for (const a of runtimeArtifacts)
      expect(new TextDecoder().decode(await infra.artifacts.readBytes({ artifactId: a._id }))).not.toContain(
        CANARY,
      );
    // Artifact metadata (the private uploads included) holds no values.
    expect(JSON.stringify(await artifacts.find({}).toArray())).not.toContain(CANARY);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(CANARY);
  });
});
