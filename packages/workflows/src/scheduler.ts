import type { Db } from 'mongodb';
import { CronExpressionParser } from 'cron-parser';
import { type Clock, newId, systemClock, type JsonObject } from '@aptamind/contracts';
import { getCollection } from '@aptamind/db';
import type { Logger } from '@aptamind/observability';
import type { WorkflowEngine } from './engine';
import { type ScheduleDoc, schedulesCollection, WORKFLOW_SCHEMA_VERSION } from './schemas';

export function computeNextFire(
  s: Pick<ScheduleDoc, 'cron' | 'intervalMinutes' | 'timezone'>,
  after: Date,
): Date {
  if (s.cron) {
    return CronExpressionParser.parse(s.cron, { currentDate: after, tz: s.timezone || 'UTC' })
      .next()
      .toDate();
  }
  if (s.intervalMinutes) return new Date(after.getTime() + s.intervalMinutes * 60_000);
  throw new Error('Schedule has neither cron nor intervalMinutes');
}

export interface UpsertScheduleInput {
  workflowKey: string;
  workflowVersion?: number;
  cron?: string;
  intervalMinutes?: number;
  timezone?: string;
  input?: JsonObject;
  labels?: Record<string, string>;
  enabled: boolean;
  owner?: { kind: string; id: string };
}

/**
 * Schedule trigger evaluation. Due-ness lives in MongoDB. Each fire creates a run with the
 * idempotency key `schedule:<id>:<scheduledFor>`, so duplicate ticks (multiple workers,
 * restarts) never produce duplicate runs.
 */
export class Scheduler {
  constructor(
    private readonly db: Db,
    private readonly engine: WorkflowEngine,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
  ) {}

  private get col() {
    return getCollection(this.db, schedulesCollection);
  }

  async upsert(input: UpsertScheduleInput): Promise<ScheduleDoc> {
    if (!!input.cron === !!input.intervalMinutes)
      throw new Error('Exactly one of cron or intervalMinutes is required');
    const now = this.clock.now();
    const timezone = input.timezone ?? 'UTC';
    const nextFireAt = input.enabled
      ? computeNextFire({ cron: input.cron, intervalMinutes: input.intervalMinutes, timezone }, now)
      : undefined;
    const filter = input.owner
      ? { 'owner.kind': input.owner.kind, 'owner.id': input.owner.id }
      : { _id: newId('sch') };
    const fields = {
      workflowKey: input.workflowKey,
      workflowVersion: input.workflowVersion,
      cron: input.cron,
      intervalMinutes: input.intervalMinutes,
      timezone,
      input: input.input ?? {},
      labels: input.labels ?? {},
      enabled: input.enabled,
      owner: input.owner,
      nextFireAt,
      updatedAt: now,
    };
    const $set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const $unset = Object.fromEntries(
      Object.entries(fields)
        .filter(([, v]) => v === undefined)
        .map(([k]) => [k, '']),
    );
    const res = await this.col.findOneAndUpdate(
      filter,
      {
        $set: $set as Partial<ScheduleDoc>,
        ...(Object.keys($unset).length ? { $unset: $unset as never } : {}),
        $setOnInsert: {
          _id: newId('sch'),
          fireCount: 0,
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return res as ScheduleDoc;
  }

  async setEnabled(scheduleId: string, enabled: boolean): Promise<void> {
    const s = await this.col.findOne({ _id: scheduleId });
    if (!s) return;
    const now = this.clock.now();
    await this.col.updateOne(
      { _id: scheduleId },
      enabled
        ? { $set: { enabled, nextFireAt: computeNextFire(s, now), updatedAt: now } }
        : { $set: { enabled, updatedAt: now }, $unset: { nextFireAt: '' } },
    );
  }

  /** Fire all due schedules once. Returns the number of runs started. */
  async tick(): Promise<number> {
    const now = this.clock.now();
    const due = await this.col
      .find({ enabled: true, nextFireAt: { $lte: now } })
      .limit(100)
      .toArray();
    let fired = 0;
    for (const s of due) {
      const scheduledFor = s.nextFireAt as Date;
      try {
        // Start the run first (idempotent), then advance the schedule. A crash between the
        // two re-fires the same scheduledFor, which resolves to the same run.
        const run = await this.engine.startRun({
          workflowKey: s.workflowKey,
          version: s.workflowVersion ?? undefined,
          input: s.input,
          labels: s.labels,
          trigger: { kind: 'schedule', scheduleId: s._id, scheduledFor },
          idempotencyKey: `schedule:${s._id}:${scheduledFor.toISOString()}`,
        });
        const next = computeNextFire(s, now > scheduledFor ? now : scheduledFor);
        const upd = await this.col.updateOne(
          { _id: s._id, nextFireAt: scheduledFor },
          {
            $set: { nextFireAt: next, lastFiredAt: now, lastRunId: run._id, updatedAt: now },
            $unset: { lastError: '' },
            $inc: { fireCount: 1 },
          },
        );
        if (upd.modifiedCount) fired += 1;
      } catch (err) {
        this.logger.error({ err, scheduleId: s._id }, 'schedule fire failed');
        await this.col.updateOne(
          { _id: s._id, nextFireAt: scheduledFor },
          {
            $set: {
              lastError: (err as Error).message,
              nextFireAt: new Date(now.getTime() + 60_000),
              updatedAt: now,
            },
          },
        );
      }
    }
    return fired;
  }

  list() {
    return this.col.find({}).sort({ workflowKey: 1 }).toArray();
  }
}
