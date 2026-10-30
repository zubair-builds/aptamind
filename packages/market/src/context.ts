import type { Db } from 'mongodb';
import type { Clock } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';

/** Dependencies shared by Market domain services. */
export interface MarketContext {
  db: Db;
  clock: Clock;
  logger: Logger;
  artifacts: ArtifactStore;
}

/**
 * Ports to the generic runtime. Market code starts workflows and manages schedules through
 * these narrow interfaces — it never reaches into engine internals.
 */
export interface RunLauncher {
  startRun(req: {
    workflowKey: string;
    version?: number;
    input: Record<string, unknown>;
    labels: Record<string, string>;
    trigger: { kind: 'manual' | 'api' | 'event'; actor?: { kind: string; id: string }; event?: string };
    idempotencyKey?: string;
  }): Promise<{ _id: string; state: string }>;
}

export interface ScheduleSync {
  upsert(input: {
    workflowKey: string;
    workflowVersion?: number;
    cron?: string;
    intervalMinutes?: number;
    timezone?: string;
    input?: Record<string, unknown>;
    labels?: Record<string, string>;
    enabled: boolean;
    owner: { kind: string; id: string };
  }): Promise<{ _id: string; nextFireAt?: Date }>;
}
