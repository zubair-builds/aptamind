import type { Clock } from '@aptamind/contracts';
import { systemClock } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { Dispatcher } from './dispatcher';
import type { WorkflowEngine } from './engine';

export interface SweepReport {
  requeuedNodes: number;
  expiredLeases: number;
  dueRetries: number;
  requeuedChunks: number;
  pumpedFanouts: number;
  finalizedFanouts: number;
  advancedRuns: number;
  timedOutWaits: number;
}

/**
 * Recovery loop. Makes MongoDB — not Redis — the source of truth for what must run:
 *  - QUEUED nodes whose transport job disappeared (Redis restart/flush) are re-dispatched;
 *  - RUNNING nodes/chunks whose lease expired (worker crash) are re-dispatched and taken over;
 *  - due retries without a transport job are re-dispatched;
 *  - fan-outs with free concurrency slots are pumped, and completed ones finalized;
 *  - runs whose advancement was interrupted are advanced;
 *  - waits past their timeout fail visibly.
 */
export class Sweeper {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly dispatcher: Dispatcher,
    private readonly logger: Logger,
    private readonly opts: { staleDispatchMs: number } = { staleDispatchMs: 60_000 },
    private readonly clock: Clock = systemClock,
  ) {}

  async sweep(): Promise<SweepReport> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - this.opts.staleDispatchMs);
    const report: SweepReport = {
      requeuedNodes: 0,
      expiredLeases: 0,
      dueRetries: 0,
      requeuedChunks: 0,
      pumpedFanouts: 0,
      finalizedFanouts: 0,
      advancedRuns: 0,
      timedOutWaits: 0,
    };
    const { nodeRuns, chunks, runs } = this.engine;

    for (const nr of await nodeRuns
      .find({ state: 'QUEUED', dispatchedAt: { $lt: stale } })
      .limit(500)
      .toArray()) {
      if (
        await this.dispatcher.isNodeJobPending({
          nodeRunId: nr._id,
          queue: nr.queue,
          dispatchSeq: nr.dispatchSeq,
        })
      )
        continue;
      await this.engine.redispatchNode(nr._id);
      report.requeuedNodes += 1;
    }
    for (const nr of await nodeRuns
      .find({ state: 'RUNNING', leaseExpiresAt: { $lt: now } })
      .limit(500)
      .toArray()) {
      await this.engine.redispatchNode(nr._id);
      report.expiredLeases += 1;
    }
    for (const nr of await nodeRuns
      .find({ state: 'RETRY_SCHEDULED', nextAttemptAt: { $lt: new Date(now.getTime() - 5_000) } })
      .limit(500)
      .toArray()) {
      if (
        await this.dispatcher.isNodeJobPending({
          nodeRunId: nr._id,
          queue: nr.queue,
          dispatchSeq: nr.dispatchSeq,
        })
      )
        continue;
      await this.engine.redispatchNode(nr._id);
      report.dueRetries += 1;
    }
    for (const c of await chunks
      .find({
        $or: [
          { state: 'QUEUED', dispatchedAt: { $lt: stale } },
          { state: 'RUNNING', leaseExpiresAt: { $lt: now } },
        ],
      })
      .limit(500)
      .toArray()) {
      if (
        c.state === 'QUEUED' &&
        (await this.dispatcher.isChunkJobPending({ chunkId: c._id, dispatchSeq: c.dispatchSeq }))
      )
        continue;
      await this.engine.redispatchChunk(c._id);
      report.requeuedChunks += 1;
    }
    for (const nr of await nodeRuns.find({ state: 'FANNING_OUT' }).limit(200).toArray()) {
      // Repair in-flight accounting drift (e.g. a crash between claiming a slot and queueing a
      // chunk). Only when the fan-out has been quiet, and via compare-and-set, so a concurrent
      // pump is never undercounted (which could exceed the concurrency bound).
      const quiet = !nr.fanout?.lastPumpAt || nr.fanout.lastPumpAt < stale;
      if (nr.fanout && quiet) {
        const inFlight = await chunks.countDocuments({
          nodeRunId: nr._id,
          state: { $in: ['QUEUED', 'RUNNING'] },
        });
        if (nr.fanout.inFlight !== inFlight) {
          await nodeRuns.updateOne(
            { _id: nr._id, state: 'FANNING_OUT', 'fanout.inFlight': nr.fanout.inFlight },
            { $set: { 'fanout.inFlight': inFlight } },
          );
        }
      }
      if (await this.engine.maybeFinalizeFanout(nr._id, { dispatch: true })) {
        report.finalizedFanouts += 1;
        continue;
      }
      if ((await this.engine.pumpFanout(nr._id)) > 0) report.pumpedFanouts += 1;
    }
    for (const nr of await nodeRuns
      .find({ state: 'WAITING', 'wait.timeoutAt': { $lt: now } })
      .limit(200)
      .toArray()) {
      const res = await nodeRuns.updateOne(
        { _id: nr._id, state: 'WAITING' },
        {
          $set: {
            state: 'FAILED',
            finishedAt: now,
            updatedAt: now,
            error: { name: 'WaitTimeout', message: `Wait "${nr.wait?.kind}" timed out` },
          },
        },
      );
      if (res.modifiedCount) {
        report.timedOutWaits += 1;
        await this.engine.advanceRun(nr.runId, { dispatch: true });
      }
    }
    // Runs that look stuck: running/waiting but not recently updated.
    for (const r of await runs
      .find({ state: { $in: ['RUNNING', 'WAITING', 'CANCELLING'] }, updatedAt: { $lt: stale } })
      .limit(200)
      .toArray()) {
      const created = await this.engine.advanceRun(r._id, { dispatch: true });
      if (created.length) report.advancedRuns += 1;
    }
    const total = Object.values(report).reduce((a, b) => a + b, 0);
    if (total > 0) this.logger.info({ report }, 'sweeper repaired workflow state');
    return report;
  }
}
