import { z } from 'zod';
import { deterministicId, jsonValueSchema } from '@aptamind/contracts';
import { defineCollection, getCollection } from '@aptamind/db';
import { metrics } from '@aptamind/observability';
import type { MarketContext } from '../context';
import type { JobService } from '../jobs/job.service';

export const AI_OPERATION_SCHEMA_VERSION = 1;

/**
 * Ledger of AI operations. One document per logical operation (job, task, workflow
 * idempotency key): the durable record of the model result, and a counter of model calls made
 * for it — more than one means an earlier call's result was lost before it was recorded
 * (crash/ack failure) and may have been charged.
 */
export const aiOperationDocSchema = z.object({
  _id: z.string(),
  task: z.string(),
  jobId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(['started', 'completed']),
  calls: z.number().int().min(1),
  result: z.object({ data: jsonValueSchema, meta: z.record(z.string(), z.unknown()) }).optional(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AiOperationDoc = z.infer<typeof aiOperationDocSchema>;

export const aiOperationsCollection = defineCollection<AiOperationDoc>({
  name: 'market_ai_operations',
  description:
    'AI operation ledger: durable results and call counts per logical operation (replay safety, cost awareness).',
  schema: aiOperationDocSchema,
  schemaVersion: AI_OPERATION_SCHEMA_VERSION,
  indexes: [
    {
      key: { jobId: 1, task: 1 },
      options: { name: 'by_job_task' },
      rationale: 'AI operations of a job.',
    },
  ],
});

export interface AiProposalOutcome<T> {
  proposalId: string;
  data: T;
  meta: Record<string, unknown>;
  /** True when no model call was made (the operation had already completed). */
  reused: boolean;
  /** Model calls made for this logical operation so far. */
  calls: number;
}

/**
 * Replay-safe AI proposals on jobs. A retry of the same logical node invocation reuses the
 * recorded result instead of calling the model again, appends the proposal at most once, and
 * makes repeated (possibly charged) calls visible.
 */
export class AiProposalService {
  constructor(
    private readonly ctx: MarketContext,
    private readonly jobs: JobService,
  ) {}

  get col() {
    return getCollection(this.ctx.db, aiOperationsCollection);
  }

  async proposeOnce<T>(
    args: { jobId: string; task: string; idempotencyKey: string },
    call: () => Promise<{ data: T; meta: Record<string, unknown> }>,
  ): Promise<AiProposalOutcome<T>> {
    const id = deterministicId('aip', args.jobId, args.task, args.idempotencyKey);
    const now = this.ctx.clock.now();
    let op = await this.col.findOne({ _id: id });
    let reused = true;
    if (op?.status !== 'completed' || !op.result) {
      op = (await this.col.findOneAndUpdate(
        { _id: id },
        {
          $setOnInsert: {
            task: args.task,
            jobId: args.jobId,
            idempotencyKey: args.idempotencyKey,
            status: 'started',
            startedAt: now,
            schemaVersion: AI_OPERATION_SCHEMA_VERSION,
            createdAt: now,
          },
          $inc: { calls: 1 },
          $set: { updatedAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      )) as AiOperationDoc;
      if (op.calls > 1) {
        metrics.inc('ai_calls_repeated_total', { task: args.task });
        this.ctx.logger.warn(
          { aiOperationId: id, calls: op.calls, task: args.task },
          'repeating an AI call whose earlier result was never recorded (the earlier call may have been charged)',
        );
      }
      const res = await call();
      const result = {
        data: JSON.parse(JSON.stringify(res.data)),
        meta: JSON.parse(JSON.stringify(res.meta)),
      };
      // First recorded result wins (a concurrent duplicate keeps the recorded one).
      await this.col.updateOne(
        { _id: id, status: 'started' },
        {
          $set: {
            status: 'completed',
            result,
            completedAt: this.ctx.clock.now(),
            updatedAt: this.ctx.clock.now(),
          },
        },
      );
      op = (await this.col.findOne({ _id: id })) as AiOperationDoc;
      reused = false;
    }
    const result = op.result as { data: T; meta: Record<string, unknown> };
    // Append the proposal to the job once (guarded on its id).
    await this.jobs.col.updateOne(
      { _id: args.jobId, 'aiProposals.id': { $ne: id } },
      {
        $push: {
          aiProposals: {
            $each: [
              {
                id,
                task: args.task,
                meta: result.meta,
                data: result.data,
                createdAt: op.completedAt ?? now,
                applied: false,
              },
            ],
            $slice: -10,
          },
        },
      },
    );
    return { proposalId: id, data: result.data, meta: result.meta, reused, calls: op.calls };
  }
}
