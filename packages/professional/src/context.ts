import type { Db } from 'mongodb';
import type { Actor, Clock, JsonObject } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';

/**
 * Bounds applied to untrusted professional documents before they are stored or parsed
 * (R-3, R-35). Later milestones extend this with parsing limits; values are enforced by the
 * Professional services, never by the generic runtime.
 */
export interface ProfessionalLimits {
  /** Largest accepted upload, checked before any byte reaches storage. */
  maxUploadBytes: number;
  /** Largest accepted document, in pages (PDF) or page-equivalents. */
  maxDocumentPages: number;
}

export const DEFAULT_PROFESSIONAL_LIMITS: Readonly<ProfessionalLimits> = Object.freeze({
  maxUploadBytes: 10 * 1024 * 1024,
  maxDocumentPages: 50,
});

export interface ProfessionalConfig {
  /**
   * The AI model the platform's gateway is configured with. It keys the AI extraction cache
   * (FE-P3 workaround: the gateway does not expose the requested model).
   */
  aiModel: string;
  limits: ProfessionalLimits;
}

/** Dependencies shared by Professional domain services. */
export interface ProfessionalContext {
  db: Db;
  clock: Clock;
  logger: Logger;
  artifacts: ArtifactStore;
  config: ProfessionalConfig;
}

/**
 * Ports to the generic runtime. Professional code starts workflows and resumes waiting ones
 * through these narrow interfaces — it never reaches into engine internals. The composition
 * root (`packages/platform`) adapts the runtime to them.
 */
export interface RunLauncher {
  startRun(req: {
    workflowKey: string;
    version?: number;
    input: Record<string, unknown>;
    labels: Record<string, string>;
    trigger: { kind: 'manual' | 'api' | 'event'; actor?: { kind: string; id: string }; event?: string };
    idempotencyKey?: string;
  }): Promise<{ _id: string; state: string; workflowKey: string; input: Record<string, unknown> }>;
}

/** Reads the states of runs Professional started (composition root: the runtime's run store). */
export interface RunStateReader {
  /** `runId → state` for the given runs (unknown ids are absent). */
  states(runIds: readonly string[]): Promise<Record<string, string>>;
}

export interface WorkflowResumer {
  /** Resumes every node waiting on `correlationKey`; returns how many were resumed. */
  resumeByCorrelationKey(correlationKey: string, payload: JsonObject, actor: Actor): Promise<number>;
}
